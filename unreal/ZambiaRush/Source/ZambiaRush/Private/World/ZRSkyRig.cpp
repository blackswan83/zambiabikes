#include "ZRSkyRig.h"

#include "Components/DirectionalLightComponent.h"
#include "Components/ExponentialHeightFogComponent.h"
#include "Components/PostProcessComponent.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/SkyLightComponent.h"
#include "Components/VolumetricCloudComponent.h"
#include "Core/ZRCore.h"
#include "Game/ZRConvert.h"
#include "HAL/IConsoleManager.h"
#include "Materials/MaterialInterface.h"

namespace
{
	static TAutoConsoleVariable<float> CVarSunIntensity(
		TEXT("zr.Sky.SunIntensity"), 6.0f,
		TEXT("Directional light intensity, lux-ish."), ECVF_Default);

	static TAutoConsoleVariable<float> CVarSkyLight(
		TEXT("zr.Sky.SkyLightIntensity"), 1.0f,
		TEXT("Sky light intensity. This is what replaces the browser game's ")
		TEXT("flat `ambient` colour term."), ECVF_Default);

	static TAutoConsoleVariable<float> CVarFogScale(
		TEXT("zr.Sky.FogScale"), 1.0f,
		TEXT("Multiplier on the fog density derived from the theme's fogFar."),
		ECVF_Default);

	static TAutoConsoleVariable<float> CVarBloom(
		TEXT("zr.Sky.Bloom"), 0.22f,
		TEXT("Bloom intensity. 0.22 matches the browser's UnrealBloomPass strength."),
		ECVF_Default);

	static TAutoConsoleVariable<int32> CVarClouds(
		TEXT("zr.Sky.Clouds"), 1,
		TEXT("Volumetric clouds on/off. First thing to drop if Metal ")
		TEXT("performance disappoints on an M1."), ECVF_Default);
}

AZRSkyRig::AZRSkyRig()
{
	PrimaryActorTick.bCanEverTick = false;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
}

void AZRSkyRig::BuildFrom(const ZR::FTheme& Theme)
{
	// ---- sun ----
	// theme.sunPos is a position in JS space; the light points from it toward
	// the scene, so the direction is its negation.
	const FVector SunDir = -ZRConv::Dir(Theme.SunPos[0], Theme.SunPos[1], Theme.SunPos[2]).GetSafeNormal();

	Sun = NewObject<UDirectionalLightComponent>(this, TEXT("Sun"));
	Sun->SetupAttachment(RootComponent);
	Sun->SetMobility(EComponentMobility::Movable);
	Sun->SetWorldRotation(SunDir.Rotation());
	Sun->SetIntensity(CVarSunIntensity.GetValueOnGameThread());
	Sun->SetLightColor(ZRConv::FromHexSRGB(Theme.Colour.Sun));
	Sun->SetDynamicShadowCascades(4);
	Sun->SetDynamicShadowDistanceMovableLight(24000.0f);   // 240 m of crisp shadow
	Sun->bAtmosphereSunLight = true;
	Sun->RegisterComponent();

	// ---- atmosphere ----
	// turbidity has no counterpart here. Rayleigh and Mie map roughly; the
	// numbers are a starting point, not a conversion.
	Atmosphere = NewObject<USkyAtmosphereComponent>(this, TEXT("Atmosphere"));
	Atmosphere->SetupAttachment(RootComponent);
	Atmosphere->SetRayleighScatteringScale(static_cast<float>(Theme.Rayleigh * 0.0331));
	Atmosphere->SetMieScatteringScale(static_cast<float>(Theme.MieCoeff * 1.0));
	Atmosphere->SetMieAnisotropy(static_cast<float>(Theme.MieG));
	Atmosphere->RegisterComponent();

	// ---- sky light ----
	SkyLight = NewObject<USkyLightComponent>(this, TEXT("SkyLight"));
	SkyLight->SetupAttachment(RootComponent);
	SkyLight->SetMobility(EComponentMobility::Movable);
	SkyLight->SourceType = ESkyLightSourceType::SLS_CapturedScene;
	SkyLight->bRealTimeCapture = true;
	SkyLight->SetIntensity(CVarSkyLight.GetValueOnGameThread());
	SkyLight->RegisterComponent();

	// ---- fog ----
	// The browser fades to theme.fog between fogNear and fogFar. Exponential
	// height fog is a different model, so density is derived from fogFar and
	// then left to be tuned by eye.
	Fog = NewObject<UExponentialHeightFogComponent>(this, TEXT("Fog"));
	Fog->SetupAttachment(RootComponent);
	Fog->SetFogDensity(static_cast<float>(FMath::Clamp(90.0 / FMath::Max(1.0, Theme.FogFar), 0.005, 0.4))
		* CVarFogScale.GetValueOnGameThread());
	Fog->SetFogInscatteringColor(ZRConv::FromHexSRGB(Theme.Colour.Fog));
	Fog->SetStartDistance(static_cast<float>(Theme.FogNear * ZRConv::MetresToUU));
	Fog->SetFogHeightFalloff(0.12f);
	Fog->RegisterComponent();

	// ---- clouds ----
	if (CVarClouds.GetValueOnGameThread() != 0)
	{
		Clouds = NewObject<UVolumetricCloudComponent>(this, TEXT("Clouds"));
		Clouds->SetupAttachment(RootComponent);
		Clouds->SetLayerBottomAltitude(3.0f);
		Clouds->SetLayerHeight(6.0f);
		if (UMaterialInterface* CloudMat = LoadObject<UMaterialInterface>(nullptr,
			TEXT("/Engine/EngineSky/VolumetricClouds/m_SimpleVolumetricCloud.m_SimpleVolumetricCloud")))
		{
			Clouds->SetMaterial(CloudMat);
		}
		Clouds->RegisterComponent();
	}

	// ---- post process ----
	PostProcess = NewObject<UPostProcessComponent>(this, TEXT("PostProcess"));
	PostProcess->SetupAttachment(RootComponent);
	PostProcess->bUnbound = true;

	FPostProcessSettings& PP = PostProcess->Settings;

	// MANUAL exposure. Unreal's default auto-exposure would pump brightness as
	// the rider passes in and out of tree shadow, which is very obviously not
	// what the browser game does with its fixed toneMappingExposure.
	PP.bOverride_AutoExposureMethod = true;
	PP.AutoExposureMethod = AEM_Manual;
	PP.bOverride_AutoExposureBias = true;
	PP.AutoExposureBias = static_cast<float>(FMath::Log2(FMath::Max(0.01, Theme.Exposure)));

	PP.bOverride_BloomIntensity = true;
	PP.BloomIntensity = CVarBloom.GetValueOnGameThread();
	PP.bOverride_BloomThreshold = true;
	PP.BloomThreshold = 0.93f;         // matches UnrealBloomPass's threshold

	PP.bOverride_MotionBlurAmount = true;
	PP.MotionBlurAmount = 0.0f;

	PostProcess->RegisterComponent();
}
