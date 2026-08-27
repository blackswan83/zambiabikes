#include "ZRGhostRider.h"

#include "Game/ZRBikeRig.h"
#include "Game/ZRConvert.h"

AZRGhostRider::AZRGhostRider()
{
	PrimaryActorTick.bCanEverTick = false;
	Root = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	RootComponent = Root;
	Rig = CreateDefaultSubobject<UZRBikeRig>(TEXT("Rig"));
	Rig->SetupAttachment(Root);
}

void AZRGhostRider::Initialise(const ZR::FGhost& InGhost, const FLinearColor& Colour)
{
	Data = InGhost;
	Rig->Build(Colour, /*bGhost=*/true);
	UpdateTo(0.0);
}

void AZRGhostRider::UpdateTo(double RaceSeconds)
{
	if (Data.Samples.empty()) return;

	const ZR::FGhostPos P = ZR::GhostPosAt(Data, RaceSeconds);
	SetActorLocationAndRotation(
		ZRConv::Pos(P.X, P.Y, P.Z),
		FRotator(0.0, ZRConv::YawDeg(P.Yaw), 0.0));

	// Ghost samples carry no wheel angle, so roll the wheels off distance
	// travelled instead. 0.34 m is the radius ZRCore uses.
	const double Rolled = (P.Z - LastZ) / 0.34;
	LastZ = P.Z;
	LastYaw = P.Yaw;
	Rig->Pose(RaceSeconds * 12.0 + Rolled, 0.0, 0.0, !P.bDone);

	SetActorHiddenInGame(P.bEmpty);
}
