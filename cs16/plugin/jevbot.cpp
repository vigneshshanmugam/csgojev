// jevbot - the engine half of the duel.
//
// Jev decides, this executes. The plugin owns a fake client's body: it walks to
// waypoints, turns at a human rate, measures what a player could sense and
// reports it to the sidecar at 20Hz; the sidecar returns the machine's state and
// a one-shot fire flag. No tactics live here.

#include <extdll.h>
#include <in_buttons.h>
#include <meta_api.h>

#include <string.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>

meta_globals_t *gpMetaGlobals;
gamedll_funcs_t *gpGamedllFuncs;
mutil_funcs_t *gpMetaUtilFuncs;

plugin_info_t Plugin_info = {
	META_INTERFACE_VERSION,
	"jevbot",
	"0.2",
	__DATE__,
	"csgojev",
	"https://github.com/",
	"JEVBOT",
	PT_ANYTIME,
	PT_ANYTIME,
};

#define SF_NORESPAWN (1 << 30)

// Waypoints, round length and footstep thresholds are generated from
// src/game/map.ts by geom.sh, so rescaling the prototype rescales the plugin
// instead of silently leaving it on the old map.
// proto.x -> x, proto.z -> y, times units/metre, no offsets (README: Design notes, Units).
#include "mapgeom.h"

static const float HOLD_X = PROTO_HOLD_X * UNITS_PER_METRE;
static const float HOLD_Y = PROTO_HOLD_Y * UNITS_PER_METRE;
static const float PEEK_X = PROTO_PEEK_X * UNITS_PER_METRE;
static const float PEEK_Y = PROTO_PEEK_Y * UNITS_PER_METRE;

// Within this of a waypoint the bot counts as standing on it, which is what
// ends a peek swing on the sidecar.
#define ARRIVE_RADIUS 24.0f
#define BOLT_SECONDS 1.5f
// The speed above which the protocol calls the enemy "moving", in m/s.
#define MOVING_MPS 1.0f

static edict_t *g_bot = NULL;
static edict_t *g_enemy = NULL;
static float g_lastMove = 0.0f;
static int g_joinStep = 0;
static float g_joinAt = 0.0f;
static int g_joinTeam = 1;
static bool g_wasAlive = false;

static float g_yaw = 90.0f;
static float g_pitch = 0.0f;
static float g_turnRate = 220.0f;
static bool g_scope = true;
static float g_lastZoom = 0.0f;

static float g_watch = 0.0f;
static float g_lastWatchAt = 0.0f;
static bool g_enemyWasAlive = false;
static float g_enemyArmAt = 0.0f;
// One weapon for both sides, so a result is about the decision layer and not
// about the loadout. Set with `jev_weapon <weapon_x> [ammo_y]`.
static char g_weapon[32] = "weapon_awp";
static char g_ammo[32] = "ammo_338magnum";
static float g_lastSelect = 0.0f;
static float g_armedAt = 0.0f;

static float g_lastSeen = -1.0f;
static bool g_preaim = true;
static float g_onTarget = 0.0f;
static float g_lastShot = -100.0f;
static int g_shots = 0;

static int g_botId = 1;
static int g_sock = -1;
static sockaddr_in g_obsTo;
static char g_obsHost[64] = "192.168.65.254";
static int g_obsPort = 27100;
static int g_intentPort = 27101;
static float g_lastObs = 0.0f;
static float g_obsInterval = 0.05f;
static int g_obsSent = 0;
static int g_intentsRx = 0;

enum MState { MS_HOLDING, MS_PEEKING, MS_SCOPED, MS_CYCLING, MS_DEAD, MS_VICTORY, MS_TIMEOUT };
static MState g_mstate = MS_HOLDING;
static int g_lastSeq = -1;
static bool g_firePending = false;

enum Phase { PH_IDLE, PH_RESTART, PH_WAIT, PH_LIVE, PH_COOLDOWN };
static Phase g_phase = PH_IDLE;
static float g_phaseAt = 0.0f;
static float g_roundStart = 0.0f;
static float g_roundLen = ROUND_SECONDS;
static int g_roundsLeft = 0;
static int g_roundNo = 0;
static int g_wins = 0, g_losses = 0, g_draws = 0;

static void Say(const char *fmt, ...)
{
	char buf[512];
	va_list ap;
	va_start(ap, fmt);
	vsnprintf(buf, sizeof(buf) - 2, fmt, ap);
	va_end(ap);
	strcat(buf, "\n");
	SERVER_PRINT(buf);
}

// The stock cs.so only registers its zBot cvars and commands when the game
// directory is "czero", so a plain cstrike server has no bots at all. Reporting
// "czero" to the game DLL is what turns them on.
static bool g_spoofGameDir = true;

static void GetGameDir(char *out)
{
	if (g_spoofGameDir) {
		strcpy(out, "czero");
		RETURN_META(MRES_SUPERCEDE);
	}
	RETURN_META(MRES_IGNORED);
}

// With the spoof on, the game DLL precaches the two CZ-only player models. The
// server shrugs off the missing files, but a cstrike client Host_Errors on them
// and drops to the menu, so hand out stock models in their place.
static int PrecacheModel(char *s)
{
	const char *sub = NULL;
	if (s && !strcmp(s, "models/player/spetsnaz/spetsnaz.mdl"))
		sub = "models/player/gign/gign.mdl";
	else if (s && !strcmp(s, "models/player/militia/militia.mdl"))
		sub = "models/player/guerilla/guerilla.mdl";
	if (sub)
		RETURN_META_VALUE(MRES_SUPERCEDE, (*g_engfuncs.pfnPrecacheModel)((char *)sub));
	RETURN_META_VALUE(MRES_IGNORED, 0);
}

// Synthetic console command plumbing. The game DLL reads its command arguments
// through the engine's Cmd_Arg* family, so the only way to hand it a command on
// behalf of a fake client is to supercede those three functions while
// MDLL_ClientCommand runs.
static bool g_fakeCmdActive = false;
static int g_fakeArgc = 0;
static char g_fakeArgv[4][128];
static char g_fakeArgs[256];

static void FakeClientCommand(edict_t *bot, const char *a0, const char *a1, const char *a2)
{
	if (FNullEnt(bot))
		return;

	g_fakeArgc = 0;
	g_fakeArgs[0] = '\0';

	const char *in[3] = { a0, a1, a2 };
	for (int i = 0; i < 3; i++) {
		if (!in[i] || !in[i][0])
			break;
		strncpy(g_fakeArgv[g_fakeArgc], in[i], sizeof(g_fakeArgv[0]) - 1);
		g_fakeArgv[g_fakeArgc][sizeof(g_fakeArgv[0]) - 1] = '\0';
		if (i > 0) {
			if (g_fakeArgs[0])
				strncat(g_fakeArgs, " ", sizeof(g_fakeArgs) - strlen(g_fakeArgs) - 1);
			strncat(g_fakeArgs, in[i], sizeof(g_fakeArgs) - strlen(g_fakeArgs) - 1);
		}
		g_fakeArgc++;
	}
	g_fakeArgv[3][0] = '\0';

	g_fakeCmdActive = true;
	MDLL_ClientCommand(bot);
	g_fakeCmdActive = false;
}

static const char *Cmd_Args()
{
	if (g_fakeCmdActive)
		RETURN_META_VALUE(MRES_SUPERCEDE, g_fakeArgs);
	RETURN_META_VALUE(MRES_IGNORED, NULL);
}

static const char *Cmd_Argv(int argc)
{
	if (g_fakeCmdActive) {
		if (argc >= 0 && argc < g_fakeArgc)
			RETURN_META_VALUE(MRES_SUPERCEDE, g_fakeArgv[argc]);
		RETURN_META_VALUE(MRES_SUPERCEDE, "");
	}
	RETURN_META_VALUE(MRES_IGNORED, NULL);
}

static int Cmd_Argc()
{
	if (g_fakeCmdActive)
		RETURN_META_VALUE(MRES_SUPERCEDE, g_fakeArgc);
	RETURN_META_VALUE(MRES_IGNORED, 0);
}

// The game DLL's GiveNamedItem is not reachable from a Metamod plugin, so the
// weapon entity is spawned and touched against the bot instead.
static void GiveItem(edict_t *player, const char *classname)
{
	edict_t *item = CREATE_NAMED_ENTITY(ALLOC_STRING(classname));
	if (FNullEnt(item)) {
		Say("[jev] CREATE_NAMED_ENTITY failed");
		return;
	}

	item->v.origin = player->v.origin;
	item->v.spawnflags |= SF_NORESPAWN;
	MDLL_Spawn(item);
	MDLL_Touch(item, player);

	if (!FNullEnt(item) && item->v.solid != SOLID_NOT)
		REMOVE_ENTITY(item);
}

static bool HasWeaponOut()
{
	const char *name = g_weapon;
	if (!strncmp(name, "weapon_", 7)) name += 7;
	return g_bot->v.weaponmodel && strstr(STRING(g_bot->v.weaponmodel), name) != NULL;
}

static void ArmBot()
{
	GiveItem(g_bot, g_weapon);
	GiveItem(g_bot, g_ammo);
	GiveItem(g_bot, g_ammo);
	FakeClientCommand(g_bot, g_weapon, "", "");
	g_armedAt = gpGlobals->time;
}

// The game DLL hands out the default pistol during spawn and selects it, which
// can land after our give, so the selection is re-asserted until it sticks.
static void KeepWeaponOut()
{
	float now = gpGlobals->time;

	if (HasWeaponOut() || now - g_lastSelect < 0.5f)
		return;

	g_lastSelect = now;
	if (now - g_armedAt > 3.0f)
		ArmBot();
	else
		FakeClientCommand(g_bot, g_weapon, "", "");
}

// No buy zone on this map, so the zBot would hold a pistol. It gets the same
// weapon as Jev's bot.
static void ArmEnemy(edict_t *enemy)
{
	if (!g_weapon[0])
		return;
	GiveItem(enemy, g_weapon);
	GiveItem(enemy, g_ammo);
	GiveItem(enemy, g_ammo);
	FakeClientCommand(enemy, g_weapon, "", "");
}

// ---------------------------------------------------------------- perception

static bool Alive(edict_t *p)
{
	return p && !FNullEnt(p) && !p->free && p->v.deadflag == DEAD_NO && p->v.health > 0;
}

// 1v1 only: the nearest other player is the opponent. A dead one is still kept
// so the round can report enemyHp 0 rather than losing track of it.
static edict_t *PickEnemy()
{
	edict_t *best = NULL, *fallback = NULL;
	float bestDist = 1.0e9f, fallbackDist = 1.0e9f;

	for (int i = 1; i <= gpGlobals->maxClients; i++) {
		edict_t *p = INDEXENT(i);
		if (FNullEnt(p) || p == g_bot || p->free)
			continue;
		if (!p->v.netname || !STRING(p->v.netname)[0])
			continue;

		float d = (p->v.origin - g_bot->v.origin).Length();
		if (Alive(p)) {
			if (d < bestDist) { bestDist = d; best = p; }
		} else if (d < fallbackDist) {
			fallbackDist = d;
			fallback = p;
		}
	}

	return best ? best : fallback;
}

static bool EyeVisible(edict_t *from, edict_t *to)
{
	TraceResult tr;
	Vector a = from->v.origin + from->v.view_ofs;
	Vector b = to->v.origin + to->v.view_ofs;

	TRACE_LINE(a, b, ignore_monsters | ignore_glass, from, &tr);
	return tr.flFraction > 0.999f;
}

static void Forward(float pitch, float yaw, Vector *out)
{
	float p = pitch * (float)M_PI / 180.0f;
	float y = yaw * (float)M_PI / 180.0f;

	out->x = cosf(p) * cosf(y);
	out->y = cosf(p) * sinf(y);
	out->z = -sinf(p);
}

// What "crosshair on the enemy" means physically: the aim ray reaches them
// before any wall. TRACE_LINE does not register fake-client hitboxes on this
// engine (the ray passes straight through a standing zBot), so the hit is
// tested analytically against the enemy's bounding box, with the world trace
// supplying only the occluder distance.
static bool CrosshairOn(edict_t *target)
{
	Vector fwd;
	Forward(g_pitch, g_yaw, &fwd);

	Vector eye = g_bot->v.origin + g_bot->v.view_ofs;
	Vector lo = target->v.origin + target->v.mins;
	Vector hi = target->v.origin + target->v.maxs;
	const float shrink = 3.0f;
	lo.x += shrink; lo.y += shrink; hi.x -= shrink; hi.y -= shrink;

	float tmin = 0.0f, tmax = 8192.0f;
	const float o[3] = { eye.x, eye.y, eye.z };
	const float d[3] = { fwd.x, fwd.y, fwd.z };
	const float a[3] = { lo.x, lo.y, lo.z };
	const float b[3] = { hi.x, hi.y, hi.z };

	for (int k = 0; k < 3; k++) {
		if (fabsf(d[k]) < 1.0e-6f) {
			if (o[k] < a[k] || o[k] > b[k])
				return false;
			continue;
		}
		float t1 = (a[k] - o[k]) / d[k];
		float t2 = (b[k] - o[k]) / d[k];
		if (t1 > t2) { float t = t1; t1 = t2; t2 = t; }
		if (t1 > tmin) tmin = t1;
		if (t2 < tmax) tmax = t2;
		if (tmin > tmax)
			return false;
	}

	TraceResult tr;
	TRACE_LINE(eye, eye + fwd * 8192.0f, ignore_monsters | ignore_glass, g_bot, &tr);
	return tr.flFraction * 8192.0f >= tmin - 1.0f;
}

static float FlatDist(float x, float y)
{
	float dx = g_bot->v.origin.x - x;
	float dy = g_bot->v.origin.y - y;
	return sqrtf(dx * dx + dy * dy);
}

static const char *Waypoint()
{
	float dh = FlatDist(HOLD_X, HOLD_Y);
	float dp = FlatDist(PEEK_X, PEEK_Y);

	if (dp <= ARRIVE_RADIUS && dp <= dh) return "peek";
	if (dh <= ARRIVE_RADIUS) return "hold";
	return NULL;
}

static bool IsSniper()
{
	return strstr(g_weapon, "awp") || strstr(g_weapon, "scout") ||
		strstr(g_weapon, "sg550") || strstr(g_weapon, "g3sg1");
}

// Seconds between shots: the AWP and scout cycle a bolt, everything else is
// bounded only by how fast a trigger can be pressed.
static float CycleSeconds()
{
	if (strstr(g_weapon, "awp")) return BOLT_SECONDS;
	if (strstr(g_weapon, "scout")) return 1.25f;
	return 0.25f;
}

// Automatic weapons fire a burst per `fire`: the trigger is held for this long
// (a standing M4 lands ~5 rounds in 0.45s). Bolt-action weapons ignore it.
static float g_burst = 0.45f;
static float g_burstUntil = -100.0f;

static float BurstSeconds()
{
	return IsSniper() ? 0.0f : g_burst;
}

static bool WeaponReady()
{
	float now = gpGlobals->time;
	return now >= g_burstUntil && (now - g_lastShot) >= CycleSeconds();
}

// ------------------------------------------------------------------- bridge

static void BridgeSend(const char *line)
{
	if (g_sock < 0)
		return;
	sendto(g_sock, line, strlen(line), 0, (struct sockaddr *)&g_obsTo, sizeof(g_obsTo));
}

static void BridgeEvent(const char *type, const char *result)
{
	char buf[160];

	if (result)
		snprintf(buf, sizeof(buf), "{\"t\":\"%s\",\"bot\":%d,\"result\":\"%s\"}\n", type, g_botId, result);
	else
		snprintf(buf, sizeof(buf), "{\"t\":\"%s\",\"bot\":%d}\n", type, g_botId);
	BridgeSend(buf);
}

static bool BridgeOpen()
{
	if (g_sock >= 0) {
		close(g_sock);
		g_sock = -1;
	}

	g_sock = socket(AF_INET, SOCK_DGRAM, 0);
	if (g_sock < 0) {
		Say("[jev] socket() failed: %s", strerror(errno));
		return false;
	}

	int flags = fcntl(g_sock, F_GETFL, 0);
	fcntl(g_sock, F_SETFL, flags | O_NONBLOCK);

	sockaddr_in in;
	memset(&in, 0, sizeof(in));
	in.sin_family = AF_INET;
	in.sin_addr.s_addr = htonl(INADDR_ANY);
	in.sin_port = htons((unsigned short)g_intentPort);
	if (bind(g_sock, (struct sockaddr *)&in, sizeof(in)) < 0) {
		Say("[jev] bind %d failed: %s", g_intentPort, strerror(errno));
		close(g_sock);
		g_sock = -1;
		return false;
	}

	memset(&g_obsTo, 0, sizeof(g_obsTo));
	g_obsTo.sin_family = AF_INET;
	g_obsTo.sin_port = htons((unsigned short)g_obsPort);
	g_obsTo.sin_addr.s_addr = inet_addr(g_obsHost);
	if (g_obsTo.sin_addr.s_addr == INADDR_NONE) {
		struct hostent *he = gethostbyname(g_obsHost);
		if (!he) {
			Say("[jev] cannot resolve %s", g_obsHost);
			close(g_sock);
			g_sock = -1;
			return false;
		}
		memcpy(&g_obsTo.sin_addr, he->h_addr, sizeof(g_obsTo.sin_addr));
	}

	Say("[jev] bridge up: obs -> %s:%d, intents on :%d", g_obsHost, g_obsPort, g_intentPort);
	return true;
}

static bool JsonNum(const char *line, const char *key, float *out)
{
	char pat[48];
	snprintf(pat, sizeof(pat), "\"%s\":", key);

	const char *at = strstr(line, pat);
	if (!at)
		return false;
	*out = (float)atof(at + strlen(pat));
	return true;
}

static bool JsonStr(const char *line, const char *key, char *out, int outLen)
{
	char pat[48];
	snprintf(pat, sizeof(pat), "\"%s\":\"", key);

	const char *at = strstr(line, pat);
	if (!at)
		return false;
	at += strlen(pat);

	const char *end = strchr(at, '"');
	if (!end)
		return false;

	int n = (int)(end - at);
	if (n >= outLen)
		n = outLen - 1;
	memcpy(out, at, n);
	out[n] = '\0';
	return true;
}

static bool JsonTrue(const char *line, const char *key)
{
	char pat[48];
	snprintf(pat, sizeof(pat), "\"%s\":true", key);
	return strstr(line, pat) != NULL;
}

static MState StateFromName(const char *name)
{
	if (!strcmp(name, "peeking")) return MS_PEEKING;
	if (!strcmp(name, "scoped")) return MS_SCOPED;
	if (!strcmp(name, "cycling")) return MS_CYCLING;
	if (!strcmp(name, "dead")) return MS_DEAD;
	if (!strcmp(name, "victory")) return MS_VICTORY;
	if (!strcmp(name, "timeout")) return MS_TIMEOUT;
	return MS_HOLDING;
}

static void ApplyIntent(const char *line)
{
	float bot = 0.0f, seq = 0.0f;
	char state[32];

	if (!JsonNum(line, "bot", &bot) || (int)bot != g_botId)
		return;
	if (!JsonNum(line, "seq", &seq) || (int)seq <= g_lastSeq)
		return;
	if (!JsonStr(line, "state", state, sizeof(state)))
		return;

	g_lastSeq = (int)seq;
	g_intentsRx++;

	MState next = StateFromName(state);
	if (next != g_mstate) {
		g_mstate = next;
		Say("[jev] intent %s seq=%d", state, g_lastSeq);
	}
	if (JsonTrue(line, "fire"))
		g_firePending = true;
}

static void PumpIntents()
{
	char buf[2048];

	if (g_sock < 0)
		return;

	while (true) {
		ssize_t n = recv(g_sock, buf, sizeof(buf) - 1, 0);
		if (n <= 0)
			break;
		buf[n] = '\0';

		char *save = buf;
		for (char *line = strtok_r(buf, "\n", &save); line; line = strtok_r(NULL, "\n", &save))
			ApplyIntent(line);
	}
}

static void SendObs()
{
	char buf[512];

	bool enemyAlive = Alive(g_enemy);
	bool visible = enemyAlive && EyeVisible(g_bot, g_enemy);
	float dist = g_enemy && !FNullEnt(g_enemy)
		? (g_enemy->v.origin - g_bot->v.origin).Length() / UNITS_PER_METRE
		: PROTO_LANE_M;
	float enemySpeed = g_enemy && !FNullEnt(g_enemy) ? g_enemy->v.velocity.Length2D() : 0.0f;
	float since = g_lastSeen < 0.0f ? -1.0f : gpGlobals->time - g_lastSeen;
	float left = g_phase == PH_LIVE ? g_roundLen - (gpGlobals->time - g_roundStart) : g_roundLen;
	const char *wp = Waypoint();

	if (left < 0.0f) left = 0.0f;

	snprintf(buf, sizeof(buf),
		"{\"t\":\"obs\",\"bot\":%d,\"hp\":%.0f,\"visible\":%s,\"moving\":%s,\"dist\":%.1f,"
		"\"enemyHp\":%.0f,\"footsteps\":%s,\"sinceSeen\":%.2f,\"roundLeft\":%.1f,"
		"\"weaponReady\":%s,\"atWaypoint\":%s,\"onTarget\":%.2f}\n",
		g_botId,
		g_bot->v.health < 0.0f ? 0.0f : g_bot->v.health,
		visible ? "true" : "false",
		enemySpeed > MOVING_MPS * UNITS_PER_METRE ? "true" : "false",
		dist,
		enemyAlive ? g_enemy->v.health : 0.0f,
		(enemySpeed > FOOTSTEP_SPEED_MPS * UNITS_PER_METRE && dist < FOOTSTEP_RANGE_M)
			? "true" : "false",
		since,
		left,
		WeaponReady() ? "true" : "false",
		wp ? (strcmp(wp, "peek") == 0 ? "\"peek\"" : "\"hold\"") : "null",
		g_onTarget);

	BridgeSend(buf);
	g_obsSent++;

	if (g_watch > 0.0f && gpGlobals->time - g_lastWatchAt >= g_watch) {
		g_lastWatchAt = gpGlobals->time;
		SERVER_PRINT(buf);
	}
}

// ------------------------------------------------------------------ driving

static float ApproachAngle(float cur, float want, float maxStep)
{
	float d = want - cur;

	while (d > 180.0f) d -= 360.0f;
	while (d < -180.0f) d += 360.0f;

	if (d > maxStep) d = maxStep;
	else if (d < -maxStep) d = -maxStep;

	cur += d;
	while (cur > 180.0f) cur -= 360.0f;
	while (cur < -180.0f) cur += 360.0f;
	return cur;
}

static void AimAt(const Vector &point, float dt)
{
	Vector d = point - (g_bot->v.origin + g_bot->v.view_ofs);
	float flat = sqrtf(d.x * d.x + d.y * d.y);
	float wantYaw = atan2f(d.y, d.x) * (180.0f / (float)M_PI);
	float wantPitch = -atan2f(d.z, flat) * (180.0f / (float)M_PI);
	float step = g_turnRate * dt;

	g_yaw = ApproachAngle(g_yaw, wantYaw, step);
	g_pitch = ApproachAngle(g_pitch, wantPitch, step);
}

static void AimDownLane(float dt)
{
	float step = g_turnRate * dt;

	g_yaw = ApproachAngle(g_yaw, 90.0f, step);
	g_pitch = ApproachAngle(g_pitch, 0.0f, step);
}

// Pre-aim, as a player does: keep the crosshair on where the opponent was last
// seen, or on their spawn before anyone has been seen. Only map knowledge and
// memory are used; the enemy's live position is not read while it is hidden.
static Vector g_lastSeenAt;
static void PreAim(float dt)
{
	if (!g_preaim) {
		AimDownLane(dt);
		return;
	}

	Vector p;
	if (g_lastSeen >= 0.0f && gpGlobals->time - g_lastSeen < 4.0f) {
		p = g_lastSeenAt;
	} else {
		p = Vector(PROTO_SPAWN_X * UNITS_PER_METRE, PROTO_SPAWN_Y * UNITS_PER_METRE, 53.0f);
	}
	AimAt(p, dt);
}

// Jev chooses whether and when; the legs and the neck are ours.
static void DriveBot(float dt, int ms)
{
	bool walking = false;
	float wpX = 0.0f, wpY = 0.0f;
	int buttons = 0;
	float fmove = 0.0f, smove = 0.0f;

	switch (g_mstate) {
	case MS_HOLDING:
		walking = true;
		wpX = HOLD_X;
		wpY = HOLD_Y;
		PreAim(dt);
		break;
	case MS_PEEKING:
		walking = true;
		wpX = PEEK_X;
		wpY = PEEK_Y;
		PreAim(dt);
		break;
	case MS_SCOPED:
	case MS_CYCLING:
		if (Alive(g_enemy))
			AimAt(g_enemy->v.origin + g_enemy->v.view_ofs, dt);
		else
			AimDownLane(dt);
		break;
	default:
		break;
	}

	if (walking) {
		float dx = wpX - g_bot->v.origin.x;
		float dy = wpY - g_bot->v.origin.y;
		float d = sqrtf(dx * dx + dy * dy);
		if (d > ARRIVE_RADIUS) {
			float y = g_yaw * (float)M_PI / 180.0f;
			fmove = ((dx * cosf(y) + dy * sinf(y)) / d) * 250.0f;
			smove = ((dx * sinf(y) - dy * cosf(y)) / d) * 250.0f;
		}
	}

	// The scope is the AWP's accuracy, so it is kept in whenever the bot is
	// armed; unscoping needs two presses on a three-step zoom and buys nothing.
	if (g_scope && IsSniper() && (g_bot->v.fov == 0.0f || g_bot->v.fov > 40.0f) &&
			gpGlobals->time - g_lastZoom > 0.5f) {
		buttons |= IN_ATTACK2;
		g_lastZoom = gpGlobals->time;
	}

	if (g_firePending) {
		g_firePending = false;
		if (WeaponReady()) {
			buttons |= IN_ATTACK;
			g_lastShot = gpGlobals->time;
			g_burstUntil = g_lastShot + BurstSeconds();
			g_shots++;
		}
	} else if (gpGlobals->time < g_burstUntil && Alive(g_enemy)) {
		buttons |= IN_ATTACK;
	}

	float angles[3] = { g_pitch, g_yaw, 0.0f };
	g_bot->v.angles[0] = 0.0f;
	g_bot->v.angles[1] = g_yaw;
	g_bot->v.v_angle[0] = g_pitch;
	g_bot->v.v_angle[1] = g_yaw;
	g_engfuncs.pfnRunPlayerMove(g_bot, angles, fmove, smove, 0.0f, (unsigned short)buttons, 0, (byte)ms);
}

// -------------------------------------------------------------- round loop

static void ResetRoundState()
{
	g_lastSeen = -1.0f;
	g_onTarget = 0.0f;
	g_lastShot = -100.0f;
	g_burstUntil = -100.0f;
	g_shots = 0;
	g_mstate = MS_HOLDING;
	g_lastSeq = -1;
	g_firePending = false;
	g_yaw = 90.0f;
	g_pitch = 0.0f;
}

static void FinishRound(const char *result)
{
	if (!strcmp(result, "win")) { g_wins++; BridgeEvent("enemy_died", NULL); }
	else if (!strcmp(result, "loss")) { g_losses++; BridgeEvent("bot_died", NULL); }
	else g_draws++;

	BridgeEvent("round_end", result);
	Say("[jev] round %d %s after %.1fs, %d shots  (w %d / l %d / d %d)",
		g_roundNo, result, gpGlobals->time - g_roundStart, g_shots, g_wins, g_losses, g_draws);

	g_phase = PH_COOLDOWN;
	g_phaseAt = gpGlobals->time + 4.0f;
}

static void RoundTick()
{
	float now = gpGlobals->time;

	switch (g_phase) {
	case PH_RESTART:
		SERVER_COMMAND("sv_restartround 1\n");
		SERVER_EXECUTE();
		g_phase = PH_WAIT;
		g_phaseAt = now + 2.5f;
		break;

	case PH_WAIT:
		if (now < g_phaseAt)
			break;
		if (!Alive(g_bot) || !Alive(g_enemy)) {
			if (now > g_phaseAt + 20.0f) {
				Say("[jev] giving up waiting for a live pair");
				g_phase = PH_IDLE;
			}
			break;
		}
		ResetRoundState();
		g_roundStart = now;
		g_roundNo++;
		g_roundsLeft--;
		BridgeEvent("round_start", NULL);
		Say("[jev] round %d start", g_roundNo);
		g_phase = PH_LIVE;
		break;

	case PH_LIVE:
		if (!Alive(g_enemy)) FinishRound("win");
		else if (!Alive(g_bot)) FinishRound("loss");
		else if (now - g_roundStart >= g_roundLen) FinishRound("draw");
		break;

	case PH_COOLDOWN:
		if (now < g_phaseAt)
			break;
		if (g_roundsLeft > 0) {
			g_phase = PH_RESTART;
		} else {
			g_phase = PH_IDLE;
			Say("[jev] duel over: %d rounds, %d wins, %d losses, %d draws, %d intents, %d obs",
				g_roundNo, g_wins, g_losses, g_draws, g_intentsRx, g_obsSent);
		}
		break;

	default:
		break;
	}
}

// Outside jev_duel the game's own rounds run (e.g. a human joined), so derive
// the brain's round events from what the engine shows. A respawn of either
// side, or the bot being teleported back to spawn, is a new round.
static bool g_freeBotAlive = false;
static bool g_freeEnemyAlive = false;
static Vector g_freeLastOrigin;
static bool g_freeStartPending = true;

static void FreePlayTick()
{
	if (g_phase != PH_IDLE || g_sock < 0)
		return;

	bool botAlive = Alive(g_bot);
	bool enemyAlive = Alive(g_enemy);
	bool teleported = botAlive && g_freeBotAlive &&
		(g_bot->v.origin - g_freeLastOrigin).Length() > 200.0f;
	if ((botAlive && !g_freeBotAlive) || (enemyAlive && !g_freeEnemyAlive) || teleported)
		g_freeStartPending = true;

	if (botAlive && enemyAlive && g_freeStartPending) {
		g_freeStartPending = false;
		ResetRoundState();
		g_roundStart = gpGlobals->time;
		BridgeEvent("round_start", NULL);
		Say("[jev] free play: round start");
	} else if (!botAlive && g_freeBotAlive) {
		BridgeEvent("bot_died", NULL);
	} else if (botAlive && !enemyAlive && g_freeEnemyAlive) {
		BridgeEvent("enemy_died", NULL);
	}

	g_freeBotAlive = botAlive;
	g_freeEnemyAlive = enemyAlive;
	g_freeLastOrigin = g_bot->v.origin;
}

// ------------------------------------------------------------------ commands

static void cmd_jev_spawn()
{
	const char *name = "JevBot";

	if (CMD_ARGC() > 1)
		g_joinTeam = atoi(CMD_ARGV(1));

	edict_t *bot = g_engfuncs.pfnCreateFakeClient(name);
	if (FNullEnt(bot)) {
		Say("[jev] CreateFakeClient returned NULL");
		return;
	}

	char reject[128] = "";
	char *infobuffer = GET_INFOKEYBUFFER(bot);
	int index = ENTINDEX(bot);

	SET_CLIENT_KEYVALUE(index, infobuffer, "model", "");
	SET_CLIENT_KEYVALUE(index, infobuffer, "rate", "3500.000000");
	SET_CLIENT_KEYVALUE(index, infobuffer, "cl_updaterate", "20");
	SET_CLIENT_KEYVALUE(index, infobuffer, "cl_lw", "1");
	SET_CLIENT_KEYVALUE(index, infobuffer, "cl_lc", "1");
	SET_CLIENT_KEYVALUE(index, infobuffer, "name", (char *)name);

	MDLL_ClientConnect(bot, (char *)name, "127.0.0.1", reject);
	if (reject[0])
		Say("[jev] ClientConnect rejected: %s", reject);
	MDLL_ClientPutInServer(bot);
	bot->v.flags |= FL_FAKECLIENT;

	g_bot = bot;
	g_lastMove = gpGlobals->time;
	g_joinStep = 1;
	g_joinAt = gpGlobals->time + 0.5f;
	Say("[jev] fake client created and put in server");
}

static void cmd_jev_where()
{
	if (!g_bot || FNullEnt(g_bot)) {
		Say("[jev] no bot");
		return;
	}

	const char *wp = Waypoint();
	Say("[jev] where: origin=(%.1f %.1f %.1f) yaw=%.1f pitch=%.1f fov=%.0f hp=%.0f "
		"wp=%s onTarget=%.2f state=%d weapon=%s",
		g_bot->v.origin.x, g_bot->v.origin.y, g_bot->v.origin.z,
		g_yaw, g_pitch, g_bot->v.fov, g_bot->v.health,
		wp ? wp : "null", g_onTarget, (int)g_mstate,
		g_bot->v.weaponmodel ? STRING(g_bot->v.weaponmodel) : "none");

	if (g_enemy && !FNullEnt(g_enemy)) {
		Say("[jev]   weapons: jev=%s enemy=%s",
			g_bot->v.weaponmodel ? STRING(g_bot->v.weaponmodel) : "none",
			g_enemy->v.weaponmodel ? STRING(g_enemy->v.weaponmodel) : "none");
		Say("[jev]   enemy: origin=(%.1f %.1f %.1f) alive=%d see=%d crosshair=%d speed=%.0f botspeed=%.0f",
			g_enemy->v.origin.x, g_enemy->v.origin.y, g_enemy->v.origin.z,
			Alive(g_enemy) ? 1 : 0, EyeVisible(g_bot, g_enemy) ? 1 : 0,
			CrosshairOn(g_enemy) ? 1 : 0, g_enemy->v.velocity.Length2D(),
			g_bot->v.velocity.Length2D());

		Vector fwd;
		Forward(g_pitch, g_yaw, &fwd);
		Vector eye = g_bot->v.origin + g_bot->v.view_ofs;
		TraceResult tr;
		TRACE_LINE(eye, eye + fwd * 8192.0f, dont_ignore_monsters | ignore_glass, g_bot, &tr);
		Say("[jev]   ray: eye=(%.1f %.1f %.1f) end=(%.1f %.1f %.1f) frac=%.4f hit=%d(%s) enemyIdx=%d enemyEye=(%.1f %.1f %.1f)",
			eye.x, eye.y, eye.z, tr.vecEndPos.x, tr.vecEndPos.y, tr.vecEndPos.z, tr.flFraction,
			FNullEnt(tr.pHit) ? -1 : ENTINDEX(tr.pHit),
			FNullEnt(tr.pHit) ? "-" : STRING(tr.pHit->v.classname), ENTINDEX(g_enemy),
			g_enemy->v.origin.x + g_enemy->v.view_ofs.x, g_enemy->v.origin.y + g_enemy->v.view_ofs.y,
			g_enemy->v.origin.z + g_enemy->v.view_ofs.z);
	}
}

static void cmd_jev_give()
{
	if (!g_bot || FNullEnt(g_bot)) {
		Say("[jev] no bot");
		return;
	}
	GiveItem(g_bot, CMD_ARGC() > 1 ? CMD_ARGV(1) : "weapon_awp");
}

static void cmd_jev_cmd()
{
	if (!g_bot || FNullEnt(g_bot)) {
		Say("[jev] no bot");
		return;
	}
	FakeClientCommand(g_bot,
		CMD_ARGC() > 1 ? CMD_ARGV(1) : "",
		CMD_ARGC() > 2 ? CMD_ARGV(2) : "",
		CMD_ARGC() > 3 ? CMD_ARGV(3) : "");
}

static void cmd_jev_spoof()
{
	g_spoofGameDir = CMD_ARGC() > 1 ? atoi(CMD_ARGV(1)) != 0 : !g_spoofGameDir;
	Say(g_spoofGameDir ? "[jev] gamedir spoof on (czero)" : "[jev] gamedir spoof off");
}

static void cmd_jev_bridge()
{
	if (CMD_ARGC() > 1) {
		strncpy(g_obsHost, CMD_ARGV(1), sizeof(g_obsHost) - 1);
		g_obsHost[sizeof(g_obsHost) - 1] = '\0';
	}
	if (CMD_ARGC() > 2) g_obsPort = atoi(CMD_ARGV(2));
	if (CMD_ARGC() > 3) g_intentPort = atoi(CMD_ARGV(3));
	BridgeOpen();
	g_freeStartPending = true;
}

static void cmd_jev_duel()
{
	if (!g_bot || FNullEnt(g_bot)) {
		Say("[jev] no bot: run jev_spawn first");
		return;
	}
	if (g_sock < 0) {
		Say("[jev] no bridge: run jev_bridge first");
		return;
	}

	g_roundsLeft = CMD_ARGC() > 1 ? atoi(CMD_ARGV(1)) : 1;
	if (CMD_ARGC() > 2) g_roundLen = (float)atof(CMD_ARGV(2));
	g_roundNo = 0;
	g_wins = g_losses = g_draws = 0;
	g_intentsRx = 0;
	g_obsSent = 0;
	g_phase = PH_RESTART;
	g_phaseAt = gpGlobals->time;
	Say("[jev] duel: %d rounds of up to %.0fs", g_roundsLeft, g_roundLen);
}

static void cmd_jev_stop()
{
	g_phase = PH_IDLE;
	g_roundsLeft = 0;
	Say("[jev] duel stopped at %d rounds: %d wins, %d losses, %d draws",
		g_roundNo, g_wins, g_losses, g_draws);
}

static void cmd_jev_report()
{
	Say("[jev] rounds %d  wins %d  losses %d  draws %d  obs %d  intents %d  phase %d  state %d",
		g_roundNo, g_wins, g_losses, g_draws, g_obsSent, g_intentsRx, (int)g_phase, (int)g_mstate);
}

static const char *AmmoFor(const char *weapon)
{
	if (strstr(weapon, "awp")) return "ammo_338magnum";
	if (strstr(weapon, "scout") || strstr(weapon, "g3sg1")) return "ammo_762nato";
	if (strstr(weapon, "m4a1") || strstr(weapon, "ak47") || strstr(weapon, "aug") ||
			strstr(weapon, "sg552") || strstr(weapon, "sg550") || strstr(weapon, "galil") ||
			strstr(weapon, "famas") || strstr(weapon, "m249")) return "ammo_556nato";
	if (strstr(weapon, "deagle")) return "ammo_50ae";
	return "ammo_9mm";
}

static void cmd_jev_arm_enemy()
{
	if (CMD_ARGC() > 1) {
		strncpy(g_weapon, CMD_ARGV(1), sizeof(g_weapon) - 1);
		g_weapon[sizeof(g_weapon) - 1] = '\0';
		strncpy(g_ammo, AmmoFor(g_weapon), sizeof(g_ammo) - 1);
		g_ammo[sizeof(g_ammo) - 1] = '\0';
	}
	if (CMD_ARGC() > 2) {
		strncpy(g_ammo, CMD_ARGV(2), sizeof(g_ammo) - 1);
		g_ammo[sizeof(g_ammo) - 1] = '\0';
	}
	if (g_bot && !FNullEnt(g_bot))
		ArmBot();
	Say("[jev] both sides use %s / %s", g_weapon, g_ammo);
}

static void cmd_jev_tune()
{
	if (CMD_ARGC() > 1) g_turnRate = (float)atof(CMD_ARGV(1));
	if (CMD_ARGC() > 2) g_scope = atoi(CMD_ARGV(2)) != 0;
	if (CMD_ARGC() > 3) g_preaim = atoi(CMD_ARGV(3)) != 0;
	Say("[jev] turnrate %.0f deg/s, scope %d, preaim %d", g_turnRate, g_scope ? 1 : 0, g_preaim ? 1 : 0);
}

static void cmd_jev_burst()
{
	if (CMD_ARGC() > 1) g_burst = (float)atof(CMD_ARGV(1));
	Say("[jev] burst %.2fs (automatic weapons only)", g_burst);
}

static void cmd_jev_watch()
{
	g_watch = CMD_ARGC() > 1 ? (float)atof(CMD_ARGV(1)) : (g_watch > 0.0f ? 0.0f : 1.0f);
	Say("[jev] obs trace every %.2fs  (hold %.0f %.0f, peek %.0f %.0f, round %.0fs)",
		g_watch, HOLD_X, HOLD_Y, PEEK_X, PEEK_Y, g_roundLen);
}

// -------------------------------------------------------------------- frame

static void JoinTick()
{
	if (g_joinStep == 0 || gpGlobals->time < g_joinAt)
		return;

	char teamArg[8];
	snprintf(teamArg, sizeof(teamArg), "%d", g_joinTeam);

	switch (g_joinStep) {
	case 1:
		FakeClientCommand(g_bot, "jointeam", teamArg, "");
		g_joinAt = gpGlobals->time + 0.3f;
		g_joinStep = 2;
		break;
	case 2:
		FakeClientCommand(g_bot, "joinclass", "1", "");
		g_joinAt = gpGlobals->time + 0.5f;
		g_joinStep = 3;
		break;
	case 3:
		ArmBot();
		g_wasAlive = true;
		g_joinStep = 0;
		Say("[jev] bot joined team and armed");
		break;
	}
}

static void StartFrame()
{
	if (g_bot && !FNullEnt(g_bot)) {
		float now = gpGlobals->time;
		float dt = gpGlobals->frametime;

		JoinTick();
		PumpIntents();
		g_enemy = PickEnemy();

		// Weapons do not survive a round respawn, so re-arm on every revival.
		bool alive = Alive(g_bot);
		if (alive && !g_wasAlive && g_joinStep == 0)
			ArmBot();
		g_wasAlive = alive;
		if (alive && g_joinStep == 0)
			KeepWeaponOut();

		// The game DLL clears and refills a spawning player's inventory, so an
		// item handed over on the first live frame is thrown away again.
		bool enemyAlive = Alive(g_enemy);
		if (enemyAlive && !g_enemyWasAlive)
			g_enemyArmAt = now + 1.0f;
		if (enemyAlive && g_enemyArmAt > 0.0f && now >= g_enemyArmAt) {
			g_enemyArmAt = 0.0f;
			ArmEnemy(g_enemy);
		}
		g_enemyWasAlive = enemyAlive;

		if (alive && Alive(g_enemy)) {
			bool see = EyeVisible(g_bot, g_enemy);
			if (see)
				g_lastSeen = now;
				g_lastSeenAt = g_enemy->v.origin + g_enemy->v.view_ofs;
			bool still = g_bot->v.velocity.Length2D() < 20.0f;
			g_onTarget = (see && still && CrosshairOn(g_enemy)) ? g_onTarget + dt : 0.0f;
		} else {
			g_onTarget = 0.0f;
		}

		RoundTick();
		FreePlayTick();

		int ms = (int)((now - g_lastMove) * 1000.0f);
		if (ms > 0) {
			if (ms > 255) ms = 255;
			g_lastMove = now;
			DriveBot(dt, ms);
		}

		if (g_sock >= 0 && now - g_lastObs >= g_obsInterval) {
			g_lastObs = now;
			SendObs();
		}
	}
	RETURN_META(MRES_IGNORED);
}

static DLL_FUNCTIONS gFunctionTable;
static enginefuncs_t gEngineFunctionTable;

C_DLLEXPORT int GetEntityAPI2(DLL_FUNCTIONS *pFunctionTable, int *interfaceVersion)
{
	memset(&gFunctionTable, 0, sizeof(DLL_FUNCTIONS));
	gFunctionTable.pfnStartFrame = StartFrame;
	memcpy(pFunctionTable, &gFunctionTable, sizeof(DLL_FUNCTIONS));
	return TRUE;
}

C_DLLEXPORT int GetEngineFunctions(enginefuncs_t *pengfuncsFromEngine, int *interfaceVersion)
{
	memset(&gEngineFunctionTable, 0, sizeof(enginefuncs_t));
	gEngineFunctionTable.pfnCmd_Args = Cmd_Args;
	gEngineFunctionTable.pfnCmd_Argv = Cmd_Argv;
	gEngineFunctionTable.pfnCmd_Argc = Cmd_Argc;
	gEngineFunctionTable.pfnGetGameDir = GetGameDir;
	gEngineFunctionTable.pfnPrecacheModel = PrecacheModel;
	memcpy(pengfuncsFromEngine, &gEngineFunctionTable, sizeof(enginefuncs_t));
	return TRUE;
}

C_DLLEXPORT int Meta_Query(char *interfaceVersion, plugin_info_t **plinfo, mutil_funcs_t *pMetaUtilFuncs)
{
	*plinfo = &Plugin_info;
	gpMetaUtilFuncs = pMetaUtilFuncs;
	return TRUE;
}

static META_FUNCTIONS gMetaFunctionTable = {
	NULL,					// pfnGetEntityAPI
	NULL,					// pfnGetEntityAPI_Post
	GetEntityAPI2,			// pfnGetEntityAPI2
	NULL,					// pfnGetEntityAPI2_Post
	NULL,					// pfnGetNewDLLFunctions
	NULL,					// pfnGetNewDLLFunctions_Post
	GetEngineFunctions,		// pfnGetEngineFunctions
	NULL,					// pfnGetEngineFunctions_Post
};

C_DLLEXPORT int Meta_Attach(PLUG_LOADTIME now, META_FUNCTIONS *pFunctionTable, meta_globals_t *pMGlobals, gamedll_funcs_t *pGamedllFuncs)
{
	gpMetaGlobals = pMGlobals;
	gpGamedllFuncs = pGamedllFuncs;
	memcpy(pFunctionTable, &gMetaFunctionTable, sizeof(META_FUNCTIONS));

	REG_SVR_COMMAND("jev_spawn", cmd_jev_spawn);
	REG_SVR_COMMAND("jev_where", cmd_jev_where);
	REG_SVR_COMMAND("jev_give", cmd_jev_give);
	REG_SVR_COMMAND("jev_cmd", cmd_jev_cmd);
	REG_SVR_COMMAND("jev_spoof", cmd_jev_spoof);
	REG_SVR_COMMAND("jev_bridge", cmd_jev_bridge);
	REG_SVR_COMMAND("jev_duel", cmd_jev_duel);
	REG_SVR_COMMAND("jev_stop", cmd_jev_stop);
	REG_SVR_COMMAND("jev_report", cmd_jev_report);
	REG_SVR_COMMAND("jev_arm_enemy", cmd_jev_arm_enemy);
	REG_SVR_COMMAND("jev_weapon", cmd_jev_arm_enemy);
	REG_SVR_COMMAND("jev_tune", cmd_jev_tune);
	REG_SVR_COMMAND("jev_watch", cmd_jev_watch);
	REG_SVR_COMMAND("jev_burst", cmd_jev_burst);
	Say("[jev] plugin attached: jev_spawn, jev_where, jev_give, jev_cmd, jev_spoof, "
		"jev_bridge, jev_duel, jev_stop, jev_report, jev_tune");
	return TRUE;
}

C_DLLEXPORT int Meta_Detach(PLUG_LOADTIME now, PL_UNLOAD_REASON reason)
{
	if (g_sock >= 0) {
		close(g_sock);
		g_sock = -1;
	}
	return TRUE;
}
