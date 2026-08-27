#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "Core/ZRCore.h"
#include "ZRGhostRider.generated.h"

class UZRBikeRig;

/**
 * Armand or Arthur, replayed from a ZRCore ghost.
 *
 * A ghost is a stream of 10 Hz position samples, so this is pure playback —
 * no physics, nothing that can desync. That is also why Ghost Codes recorded
 * in the browser replay here unchanged: the format is positions and a first
 * name, and nothing else.
 */
UCLASS()
class AZRGhostRider : public AActor
{
	GENERATED_BODY()

public:
	AZRGhostRider();

	void Initialise(const ZR::FGhost& InGhost, const FLinearColor& Colour);

	/** @param RaceSeconds time since the flag dropped. */
	void UpdateTo(double RaceSeconds);

	const ZR::FGhost& Ghost() const { return Data; }

private:
	ZR::FGhost Data;
	double LastYaw = 0.0;
	double LastZ = 0.0;

	UPROPERTY() TObjectPtr<USceneComponent> Root;
	UPROPERTY() TObjectPtr<UZRBikeRig> Rig;
};
