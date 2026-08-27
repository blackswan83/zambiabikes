#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Pawn.h"
#include "Core/ZRCore.h"
#include "ZRRiderPawn.generated.h"

class UCameraComponent;
class UZRBikeRig;
class AZRPlayerController;

/**
 * The player's bike. Driven entirely by ZRCore::StepRider — no Chaos Vehicles,
 * no rigid body, no CharacterMovementComponent.
 *
 * That is the load-bearing decision of the whole port. Because the physics is
 * the same code the browser runs, the feel is identical rather than "retuned
 * to feel similar", the AI ghost times stay comparable, and a Ghost Code
 * recorded in a browser replays here and vice versa. Terrain contact is
 * ZR::HeightAt; prop collision is ZRCore's own spatial hash. Unreal is only
 * ever told where the bike ended up.
 */
UCLASS()
class AZRRiderPawn : public APawn
{
	GENERATED_BODY()

public:
	AZRRiderPawn();

	virtual void Tick(float DeltaSeconds) override;

	void Initialise(const ZR::FWorld* InWorld, std::vector<uint8_t>* InTaken, const FLinearColor& Jersey);

	/** The countdown holds this false; "GO!" sets it true. */
	void SetSimulating(bool bInSimulating) { bSimulating = bInSimulating; }
	bool IsSimulating() const { return bSimulating; }

	const ZR::FRiderState& State() const { return Cur; }

	/** Events raised by the simulation since the last call. */
	TArray<ZR::FEvent> DrainEvents();

	UCameraComponent* GetCameraComponent() const { return Camera; }

private:
	void AdvanceCamera(double Dt);
	void ApplyRenderPose(double Alpha);

	const ZR::FWorld* World = nullptr;

	/** Shared with every other rider on the hill: coins are a single field and
	 *  a coin taken by one rider is gone for the rest. Owned by AZRGameMode. */
	std::vector<uint8_t>* Taken = nullptr;

	/** Cur is the authoritative simulation state. Prev is the step before it,
	 *  kept solely so the visuals can be interpolated — see Tick. */
	ZR::FRiderState Cur;
	ZR::FRiderState Prev;

	std::vector<ZR::FEvent> StepEvents;
	TArray<ZR::FEvent> Pending;

	double Accumulator = 0.0;
	bool bSimulating = false;

	/** Camera position in JS space (metres), smoothed on the fixed step so it
	 *  behaves the same at 60 and 120 Hz. */
	double CamX = 0, CamY = 0, CamZ = 0;
	double CamPrevX = 0, CamPrevY = 0, CamPrevZ = 0;
	bool bCameraSnapped = false;
	double Dip = 0.0;
	double Shake = 0.0;

	UPROPERTY() TObjectPtr<USceneComponent> Root;
	UPROPERTY() TObjectPtr<UZRBikeRig> Rig;
	UPROPERTY() TObjectPtr<UCameraComponent> Camera;
};
