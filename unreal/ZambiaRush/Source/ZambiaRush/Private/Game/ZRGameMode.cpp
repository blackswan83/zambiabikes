#include "ZRGameMode.h"

#include "Audio/ZRSynth.h"
#include "Game/ZRConvert.h"
#include "Game/ZRGhostRider.h"
#include "Game/ZRHUD.h"
#include "Game/ZRPlayerController.h"
#include "Game/ZRRiderPawn.h"
#include "HAL/IConsoleManager.h"
#include "Kismet/GameplayStatics.h"
#include "World/ZRPropField.h"
#include "World/ZRSkyRig.h"
#include "World/ZRTerrainActor.h"

namespace
{
	static TAutoConsoleVariable<FString> CVarTrack(
		TEXT("zr.Track"), TEXT("miombo"),
		TEXT("Which track to build: miombo, baobab, kasanka, zambezi, falls. ")
		TEXT("The vertical slice is tuned for miombo; the other four generate ")
		TEXT("correctly (ZRCore is verified bit-exact on all five) but their ")
		TEXT("set dressing - river water, the falls, the bats - is not built yet."),
		ECVF_Default);

	static TAutoConsoleVariable<int32> CVarGhosts(
		TEXT("zr.Ghosts"), 1,
		TEXT("Show Armand's and Arthur's ghosts."), ECVF_Default);

	// css/styles.css :root
	constexpr uint32 ColourForest = 0x1F7A48;   // Armand
	constexpr uint32 ColourCopper = 0xE8791D;   // Arthur
	constexpr uint32 ColourRiver  = 0x2A9D8F;   // the player
}

AZRGameMode::AZRGameMode()
{
	PrimaryActorTick.bCanEverTick = true;

	// AGameModeBase is an AInfo and has no root of its own, but the synth is a
	// scene component and needs one.
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	Synth = CreateDefaultSubobject<UZRSynth>(TEXT("Synth"));
	Synth->SetupAttachment(RootComponent);
	Synth->bAlwaysPlay = true;
	Synth->bIsUISound = true;

	// Deliberately null: StartPlay spawns the rider itself, at the start gate
	// ZRCore nominates. Leaving DefaultPawnClass set would auto-spawn a second
	// bike at the world origin and strand it there.
	DefaultPawnClass = nullptr;
	PlayerControllerClass = AZRPlayerController::StaticClass();
	HUDClass = AZRHUD::StaticClass();
	bStartPlayersAsSpectators = false;
}

void AZRGameMode::StartPlay()
{
	Super::StartPlay();

	const FString TrackId = CVarTrack.GetValueOnGameThread();
	const ZR::FTrackDef* Def = ZR::FindTrack(TCHAR_TO_UTF8(*TrackId));
	if (!Def)
	{
		UE_LOG(LogTemp, Error, TEXT("ZRGameMode: unknown track '%s'."), *TrackId);
		Def = ZR::FindTrack("miombo");
	}

	if (Synth) Synth->Start();

	const double BuildStart = FPlatformTime::Seconds();
	SimWorld = ZR::BuildWorld(*Def);
	CoinsTaken.assign(SimWorld.Coins.size(), 0);

	// Armand and Arthur are simulated through the SAME StepRider the player
	// uses, which is what makes their times honestly beatable rather than a
	// designer's guess. About 5,400 steps each; sub-millisecond.
	const ZR::FGhost Armand = ZR::SimulateAI(SimWorld, ZR::AIStyleArmand());
	const ZR::FGhost Arthur = ZR::SimulateAI(SimWorld, ZR::AIStyleArthur());

	GoldTimeMs = FMath::Min(Armand.TimeMs, Arthur.TimeMs);
	SilverTimeMs = FMath::Max(Armand.TimeMs, Arthur.TimeMs);
	BronzeTimeMs = FMath::RoundToInt32(SilverTimeMs * 1.35);

	UE_LOG(LogTemp, Log, TEXT("ZRGameMode: %s built in %.0f ms. Gold %d ms, silver %d, bronze %d."),
		*FString(Def->Name.c_str()), (FPlatformTime::Seconds() - BuildStart) * 1000.0,
		GoldTimeMs, SilverTimeMs, BronzeTimeMs);

	UWorld* W = GetWorld();
	FActorSpawnParameters Params;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

	Sky = W->SpawnActor<AZRSkyRig>(AZRSkyRig::StaticClass(), FTransform::Identity, Params);
	Sky->BuildFrom(Def->Theme);

	Terrain = W->SpawnActor<AZRTerrainActor>(AZRTerrainActor::StaticClass(), FTransform::Identity, Params);
	Terrain->BuildFrom(SimWorld);

	Props = W->SpawnActor<AZRPropField>(AZRPropField::StaticClass(), FTransform::Identity, Params);
	Props->BuildFrom(SimWorld);

	// The rider spawns wherever ZRCore says the start line is.
	const ZR::FTrailPoint& Start = SimWorld.Trail[2];
	PlayerRider = W->SpawnActor<AZRRiderPawn>(AZRRiderPawn::StaticClass(),
		FTransform(ZRConv::Pos(Start)), Params);
	PlayerRider->Initialise(&SimWorld, &CoinsTaken, ZRConv::FromHexSRGB(ColourRiver));

	if (APlayerController* PC = UGameplayStatics::GetPlayerController(W, 0))
	{
		PC->Possess(PlayerRider);
		PC->SetViewTarget(PlayerRider);
	}

	if (CVarGhosts.GetValueOnGameThread() != 0)
	{
		const ZR::FGhost* Both[2] = { &Armand, &Arthur };
		const uint32 Colours[2] = { ColourForest, ColourCopper };
		for (int32 I = 0; I < 2; I++)
		{
			AZRGhostRider* G = W->SpawnActor<AZRGhostRider>(
				AZRGhostRider::StaticClass(), FTransform::Identity, Params);
			G->Initialise(*Both[I], ZRConv::FromHexSRGB(Colours[I]));
			Ghosts.Add(G);
		}
	}
}

void AZRGameMode::HandleEvents()
{
	if (!PlayerRider) return;

	for (const ZR::FEvent& E : PlayerRider->DrainEvents())
	{
		switch (E.Type)
		{
		case ZR::EEvent::Coin:
			if (Props) Props->HideCoin(E.Index);
			if (Synth) Synth->PlayCoin();
			break;

		case ZR::EEvent::Hop:
			if (Synth) Synth->PlayHop();
			break;

		case ZR::EEvent::Land:
			if (Synth) Synth->PlayLand(E.bHard);
			break;

		case ZR::EEvent::Crash:
			if (Synth) Synth->PlayCrash();
			break;

		case ZR::EEvent::Gate:
			if (Synth) Synth->PlayGate();
			break;

		case ZR::EEvent::TurboOn:
			if (Synth) Synth->PlayTurboOn();
			break;

		case ZR::EEvent::Trick:
		{
			// Same wording the browser game uses in its trick toast.
			FString Text;
			if (E.Flips && E.Spins) Text = FString::Printf(TEXT("COMBO!  +%d"), E.Pts);
			else if (E.Flips)       Text = FString::Printf(TEXT("%s x%d  +%d"),
				E.bBack ? TEXT("BACKFLIP") : TEXT("FRONTFLIP"), E.Flips, E.Pts);
			else                    Text = FString::Printf(TEXT("%d SPIN  +%d"), E.Spins * 360, E.Pts);
			Toast = FText::FromString(Text);
			ToastT = 1.6;
			if (Synth) Synth->PlayTrick();
			break;
		}

		case ZR::EEvent::BigAir:
			Toast = FText::FromString(TEXT("BIG AIR  +75"));
			ToastT = 1.2;
			break;

		case ZR::EEvent::Finish:
		{
			FinalMs = FMath::RoundToInt32(PlayerRider->State().FinishT * 1000.0);
			AwardedMedal =
				FinalMs <= GoldTimeMs   ? EZRMedal::Gold :
				FinalMs <= SilverTimeMs ? EZRMedal::Silver :
				FinalMs <= BronzeTimeMs ? EZRMedal::Bronze : EZRMedal::None;
			State = EZRRaceState::Finished;
			if (Synth) Synth->PlayFinish();
			break;
		}

		default:
			break;
		}
	}
}

void AZRGameMode::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	if (!PlayerRider) return;

	switch (State)
	{
	case EZRRaceState::Countdown:
		Countdown -= DeltaSeconds;
		if (Countdown <= 0.0)
		{
			Countdown = 0.0;
			GoBanner = 0.7;
			State = EZRRaceState::Racing;
			PlayerRider->SetSimulating(true);
		}
		break;

	case EZRRaceState::Racing:
		if (GoBanner > 0.0) GoBanner -= DeltaSeconds;
		break;

	case EZRRaceState::Finished:
		break;
	}

	HandleEvents();

	if (ToastT > 0.0) ToastT -= DeltaSeconds;

	// Ghosts run off the player's own race clock, so they are always racing
	// the same moment the player is.
	if (State != EZRRaceState::Countdown)
	{
		const double RaceSeconds = PlayerRider->State().T;
		for (AZRGhostRider* G : Ghosts)
		{
			if (G) G->UpdateTo(RaceSeconds);
		}
	}
}
