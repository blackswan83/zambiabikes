#include "ZRBikeRig.h"

#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"

namespace
{
	// Engine primitives are 100 uu across, centred on the origin, cylinders
	// running along Z. Everything below is expressed in metres and scaled by
	// this, so the numbers read like the bike dimensions they are.
	constexpr float M = 100.0f;

	const TCHAR* ShapeCube     = TEXT("/Engine/BasicShapes/Cube.Cube");
	const TCHAR* ShapeCylinder = TEXT("/Engine/BasicShapes/Cylinder.Cylinder");
	const TCHAR* ShapeSphere   = TEXT("/Engine/BasicShapes/Sphere.Sphere");

	// Zambia Bikes palette (css/styles.css :root).
	const FLinearColor Ink   = FLinearColor::FromSRGBColor(FColor(0x2B, 0x1B, 0x10));
	const FLinearColor Steel = FLinearColor::FromSRGBColor(FColor(0x6C, 0x54, 0x42));
	const FLinearColor Skin  = FLinearColor::FromSRGBColor(FColor(0x8D, 0x5A, 0x3B));
}

UZRBikeRig::UZRBikeRig()
{
	PrimaryComponentTick.bCanEverTick = false;
}

UStaticMeshComponent* UZRBikeRig::AddPiece(const TCHAR* ShapePath, const TCHAR* Name,
	const FVector& RelLocationCm, const FRotator& RelRotation,
	const FVector& ScaleCm, const FLinearColor& Colour, bool bGhost)
{
	UStaticMesh* Mesh = LoadObject<UStaticMesh>(nullptr, ShapePath);
	if (!Mesh)
	{
		// If this fires in a packaged build and not in the editor, the cause is
		// almost certainly a missing +DirectoriesToAlwaysCook entry for
		// /Engine/BasicShapes in Config/DefaultGame.ini.
		UE_LOG(LogTemp, Error, TEXT("ZRBikeRig: could not load %s"), ShapePath);
		return nullptr;
	}

	UStaticMeshComponent* C = NewObject<UStaticMeshComponent>(this, Name);
	C->SetStaticMesh(Mesh);
	C->SetupAttachment(Body ? Body.Get() : static_cast<USceneComponent*>(this));
	C->SetRelativeLocation(RelLocationCm);
	C->SetRelativeRotation(RelRotation);
	C->SetRelativeScale3D(ScaleCm / 100.0);
	C->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	C->SetCastShadow(true);
	C->RegisterComponent();

	const TCHAR* MatPath = bGhost
		? TEXT("/Game/Materials/M_ZRGhost.M_ZRGhost")
		: TEXT("/Game/Materials/M_ZRVertexColor.M_ZRVertexColor");
	if (UMaterialInterface* Parent = LoadObject<UMaterialInterface>(nullptr, MatPath))
	{
		UMaterialInstanceDynamic* MID = UMaterialInstanceDynamic::Create(Parent, this);
		MID->SetVectorParameterValue(TEXT("Tint"), Colour);
		MID->SetScalarParameterValue(TEXT("Roughness"), 0.65f);
		C->SetMaterial(0, MID);
		Materials.Add(MID);
	}
	return C;
}

void UZRBikeRig::Build(const FLinearColor& JerseyColour, bool bGhost)
{
	Body = NewObject<USceneComponent>(this, TEXT("Body"));
	Body->SetupAttachment(this);
	Body->RegisterComponent();

	// Wheels. ZRCore rolls the wheel with radius 0.34 m (st.wheelSpin is
	// distance / 0.34), so the visual radius has to match or the wheels
	// visibly skate.
	const FVector WheelScale(0.68f * M, 0.68f * M, 0.06f * M);
	const FRotator WheelRot(0.f, 0.f, 90.f);   // cylinder axis Z -> lateral (Y)
	RearWheel  = AddPiece(ShapeCylinder, TEXT("RearWheel"),
		FVector(-0.55f * M, 0.f, 0.34f * M), WheelRot, WheelScale, Ink, bGhost);
	FrontWheel = AddPiece(ShapeCylinder, TEXT("FrontWheel"),
		FVector(0.55f * M, 0.f, 0.34f * M), WheelRot, WheelScale, Ink, bGhost);

	// Frame: down tube, top tube, seat tube, chainstay.
	AddPiece(ShapeCube, TEXT("DownTube"),
		FVector(-0.02f * M, 0.f, 0.52f * M), FRotator(-32.f, 0.f, 0.f),
		FVector(0.80f * M, 0.05f * M, 0.05f * M), JerseyColour, bGhost);
	AddPiece(ShapeCube, TEXT("TopTube"),
		FVector(-0.05f * M, 0.f, 0.83f * M), FRotator(-6.f, 0.f, 0.f),
		FVector(0.62f * M, 0.045f * M, 0.045f * M), JerseyColour, bGhost);
	AddPiece(ShapeCube, TEXT("SeatTube"),
		FVector(-0.34f * M, 0.f, 0.66f * M), FRotator(18.f, 0.f, 0.f),
		FVector(0.05f * M, 0.05f * M, 0.52f * M), JerseyColour, bGhost);
	AddPiece(ShapeCube, TEXT("ChainStay"),
		FVector(-0.44f * M, 0.f, 0.37f * M), FRotator(6.f, 0.f, 0.f),
		FVector(0.42f * M, 0.05f * M, 0.04f * M), JerseyColour, bGhost);

	// Fork and bars.
	AddPiece(ShapeCube, TEXT("Fork"),
		FVector(0.50f * M, 0.f, 0.66f * M), FRotator(14.f, 0.f, 0.f),
		FVector(0.06f * M, 0.05f * M, 0.62f * M), Steel, bGhost);
	AddPiece(ShapeCube, TEXT("Bars"),
		FVector(0.45f * M, 0.f, 1.00f * M), FRotator::ZeroRotator,
		FVector(0.05f * M, 0.72f * M, 0.04f * M), Ink, bGhost);
	AddPiece(ShapeCube, TEXT("Saddle"),
		FVector(-0.40f * M, 0.f, 0.94f * M), FRotator::ZeroRotator,
		FVector(0.26f * M, 0.11f * M, 0.05f * M), Ink, bGhost);

	// Crank, which turns with the wheels.
	Crank = AddPiece(ShapeCube, TEXT("Crank"),
		FVector(-0.05f * M, 0.f, 0.30f * M), FRotator::ZeroRotator,
		FVector(0.34f * M, 0.16f * M, 0.04f * M), Steel, bGhost);

	// Rider.
	Torso = AddPiece(ShapeCube, TEXT("Torso"),
		FVector(-0.16f * M, 0.f, 1.16f * M), FRotator(-38.f, 0.f, 0.f),
		FVector(0.30f * M, 0.34f * M, 0.52f * M), JerseyColour, bGhost);
	AddPiece(ShapeSphere, TEXT("Head"),
		FVector(0.10f * M, 0.f, 1.44f * M), FRotator::ZeroRotator,
		FVector(0.24f * M, 0.24f * M, 0.26f * M), Skin, bGhost);
	AddPiece(ShapeSphere, TEXT("Helmet"),
		FVector(0.10f * M, 0.f, 1.50f * M), FRotator::ZeroRotator,
		FVector(0.28f * M, 0.28f * M, 0.22f * M), JerseyColour, bGhost);
	AddPiece(ShapeCube, TEXT("ArmL"),
		FVector(0.16f * M, 0.20f * M, 1.14f * M), FRotator(-58.f, 0.f, 0.f),
		FVector(0.10f * M, 0.10f * M, 0.56f * M), Skin, bGhost);
	AddPiece(ShapeCube, TEXT("ArmR"),
		FVector(0.16f * M, -0.20f * M, 1.14f * M), FRotator(-58.f, 0.f, 0.f),
		FVector(0.10f * M, 0.10f * M, 0.56f * M), Skin, bGhost);
	LegL = AddPiece(ShapeCube, TEXT("LegL"),
		FVector(-0.10f * M, 0.13f * M, 0.62f * M), FRotator::ZeroRotator,
		FVector(0.13f * M, 0.13f * M, 0.60f * M), Ink, bGhost);
	LegR = AddPiece(ShapeCube, TEXT("LegR"),
		FVector(-0.10f * M, -0.13f * M, 0.62f * M), FRotator::ZeroRotator,
		FVector(0.13f * M, 0.13f * M, 0.60f * M), Ink, bGhost);
}

void UZRBikeRig::Pose(double WheelSpin, double Lean, double Pitch, bool bPedalling)
{
	const float SpinDeg = static_cast<float>(FMath::RadiansToDegrees(WheelSpin));
	if (FrontWheel) FrontWheel->SetRelativeRotation(FRotator(0.f, 0.f, 90.f + SpinDeg));
	if (RearWheel)  RearWheel->SetRelativeRotation(FRotator(0.f, 0.f, 90.f + SpinDeg));

	// Cranks turn at roughly a third of wheel rate — close enough to a real
	// gear ratio that the legs read as driving rather than windmilling.
	const float CrankDeg = bPedalling ? SpinDeg * 0.33f : 0.f;
	if (Crank) Crank->SetRelativeRotation(FRotator(CrankDeg, 0.f, 0.f));

	const float LegSwing = bPedalling ? FMath::Sin(FMath::DegreesToRadians(CrankDeg)) * 22.f : 0.f;
	if (LegL) LegL->SetRelativeRotation(FRotator(LegSwing, 0.f, 0.f));
	if (LegR) LegR->SetRelativeRotation(FRotator(-LegSwing, 0.f, 0.f));

	// The rider leans into the turn, and the whole rig carries the trick flip.
	if (Body)
	{
		Body->SetRelativeRotation(FRotator(
			static_cast<float>(FMath::RadiansToDegrees(Pitch)),
			0.f,
			static_cast<float>(-Lean * 26.0)));
	}
}
