MM = ../vendor/metamod-p-src
HLSDK = $(MM)/hlsdk

NAME = jevbot
OBJECTS = jevbot.cpp h_export.cpp

INCLUDE = -I. -I$(HLSDK)/common -I$(HLSDK)/dlls -I$(HLSDK)/engine \
	-I$(HLSDK)/pm_shared -I$(MM)/metamod

CFLAGS = -O2 -fPIC -shared -m32 -std=gnu++11 \
	-Dlinux -D__linux__ -D__USE_GNU -DNDEBUG \
	-fno-strict-aliasing -w

all:
	mkdir -p Release
	g++ $(INCLUDE) $(CFLAGS) $(OBJECTS) -ldl -o Release/$(NAME)_mm_i386.so

clean:
	rm -rf Release
