#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "Core/ZRCore.h"
#include "ZRGameMode.generated.h"

class AZRTerrainActor;
class AZRPropField;
class AZRSkyRig;
class AZRRiderPawn;
class AZRGhostRider;

UENUM()
enum class EZRRaceState : uint8
{
	Countdown,
	Racing,
	Finished
};

UENUM()
enum class EZRMedal : uint8
{
	None,
	Bronze,
	Silver,
	Gold
};

/**
 * Builds the hill and runs the race.
 *
 * There is no .umap for this. GameDefaultMap points at the engine's empty
 * /Engine/Maps/Entry and everything below is spawned here, which is what keeps
 * the repository free of binary assets.
 */
UCLASS()
class AZRGameMode : public AGameModeBase
{
	GENERATED_BODY()

public:
	AZRGameMode();

	virtual void StartPlay() override;
	virtual void Tick(float DeltaSeconds) override;

	// --- read by AZRHUD ---
	EZRRaceState RaceState() const { return State; }
	double CountdownRemaining() const { return Countdown; }
	double GoBannerRemaining() const { return GoBanner; }
	const ZR::FWorld& World() const { return SimWorld; }
	AZRRiderPawn* Rider() const { return PlayerRider; }
	EZRMedal Medal() const { return AwardedMedal; }
	int32 GoldMs() const { return GoldTimeMs; }
	int32 SilverMs() const { return SilverTimeMs; }
	int32 BronzeMs() const { return BronzeTimeMs; }
	int32 FinalTimeMs() const { return FinalMs; }

	/** Most recent trick banked, for the HUD toast. Empty when stale. */
	FText TrickToast() const { return Toast; }
	double ToastRemaining() const { return ToastT; }

private:
	void HandleEvents();

	ZR::FWorld SimWorld;
	std::vector<uint8_t> CoinsTaken;

	EZRRaceState State = EZRRaceState::Countdown;
	double Countdown = 2.7;      // js/game3d.js: 2.7 s of numbers...
	double GoBanner = 0.0;       // ...then 0.7 s of GO! while already riding
	int32 FinalMs = 0;
	EZRMedal AwardedMedal = EZRMedal::None;
	int32 GoldTimeMs = 0, SilverTimeMs = 0, BronzeTimeMs = 0;

	FText Toast;
	double ToastT = 0.0;

	UPROPERTY() TObjectPtr<class UZRSynth> Synth;
	UPROPERTY() TObjectPtr<AZRTerrainActor> Terrain;
	UPROPERTY() TObjectPtr<AZRPropField> Props;
	UPROPERTY() TObjectPtr<AZRSkyRig> Sky;
	UPROPERTY() TObjectPtr<AZRRiderPawn> PlayerRider;
	UPROPERTY() TArray<TObjectPtr<AZRGhostRider>> Ghosts;
};
