#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "ZRSkyRig.generated.h"

namespace ZR { struct FTheme; }

/**
 * Sky, sun, fog, cloud and post process, driven from the track's theme block.
 *
 * The browser game runs the three.js Sky shader with real Rayleigh/Mie
 * scattering, a bloom pass on true HDR highlights and ACES tone mapping
 * (js/game3d.js:381). Unreal has better versions of all of that, so this is
 * the part of the port that is meant to LOOK different — same palette, same
 * time of day, better light.
 *
 * The mapping is honest but not exact, and cannot be: `turbidity` is a
 * Preetham parameter with no ASkyAtmosphere equivalent, and the theme's
 * sky/fog hex colours do not map onto a physical atmosphere at all. So every
 * value below is also an FAutoConsoleVariable — tune it live in PIE with
 * `zr.Sky.*` and paste the numbers back rather than paying a three-minute
 * rebuild per adjustment. There is no Live Coding on Mac.
 */
UCLASS()
class AZRSkyRig : public AActor
{
	GENERATED_BODY()

public:
	AZRSkyRig();

	void BuildFrom(const ZR::FTheme& Theme);

private:
	UPROPERTY() TObjectPtr<class UDirectionalLightComponent> Sun;
	UPROPERTY() TObjectPtr<class USkyLightComponent> SkyLight;
	UPROPERTY() TObjectPtr<class USkyAtmosphereComponent> Atmosphere;
	UPROPERTY() TObjectPtr<class UExponentialHeightFogComponent> Fog;
	UPROPERTY() TObjectPtr<class UVolumetricCloudComponent> Clouds;
	UPROPERTY() TObjectPtr<class UPostProcessComponent> PostProcess;
};
