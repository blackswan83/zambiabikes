#include "ZRRiderPawn.h"

#include "Camera/CameraComponent.h"
#include "Game/ZRBikeRig.h"
#include "Game/ZRConvert.h"
#include "Game/ZRPlayerController.h"
#include "HAL/IConsoleManager.h"

namespace
{
	// js/game3d.js:3154-3161. Unreal's FieldOfView is HORIZONTAL, so unlike
	// Three.js we set this angle directly rather than solving a vertical one.
	constexpr double HFovBase = 98.0;
	constexpr double HFovMax  = 116.0;

	static TAutoConsoleVariable<int32> CVarReduceMotion(
		TEXT("zr.ReduceMotion"), 0,
		TEXT("Suppress the off-trail camera rumble, mirroring the browser ")
		TEXT("game's prefers-reduced-motion handling."),
		ECVF_Default);

	static TAutoConsoleVariable<float> CVarCameraRoll(
		TEXT("zr.Camera.Roll"), -0.35f,
		TEXT("Camera bank per unit of rider lean. Matches the browser game's ")
		TEXT("-lean*0.35. The SIGN may need flipping: the JS-to-Unreal mapping ")
		TEXT("changes handedness, and roll direction was derived rather than ")
		TEXT("observed. If the camera banks out of the turns, negate this."),
		ECVF_Default);

	/** Shortest-arc interpolation for an angle in radians. */
	double LerpAngle(double A, double B, double T)
	{
		double D = B - A;
		while (D > PI) D -= 2.0 * PI;
		while (D < -PI) D += 2.0 * PI;
		return A + D * T;
	}
}

AZRRiderPawn::AZRRiderPawn()
{
	PrimaryActorTick.bCanEverTick = true;
	// Tick after everything that could move: the camera reads the rider's
	// post-step position in the same frame.
	PrimaryActorTick.TickGroup = TG_PostPhysics;

	Root = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	RootComponent = Root;

	Rig = CreateDefaultSubobject<UZRBikeRig>(TEXT("Rig"));
	Rig->SetupAttachment(Root);

	Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
	Camera->SetupAttachment(Root);
	// The chase camera is positioned in world space by hand, exactly as the
	// browser game does, so it must not inherit the bike's transform.
	Camera->SetUsingAbsoluteLocation(true);
	Camera->SetUsingAbsoluteRotation(true);
	Camera->bUsePawnControlRotation = false;
}

void AZRRiderPawn::Initialise(const ZR::FWorld* InWorld, std::vector<uint8_t>* InTaken,
                              const FLinearColor& Jersey)
{
	World = InWorld;
	Taken = InTaken;
	if (!World) return;

	Cur = ZR::NewRider(*World);
	Prev = Cur;
	Accumulator = 0.0;
	bCameraSnapped = false;

	Rig->Build(Jersey);
	ApplyRenderPose(1.0);
	AdvanceCamera(ZR::DT);
}

TArray<ZR::FEvent> AZRRiderPawn::DrainEvents()
{
	TArray<ZR::FEvent> Out = MoveTemp(Pending);
	Pending.Reset();
	return Out;
}

void AZRRiderPawn::AdvanceCamera(double Dt)
{
	if (!World) return;

	CamPrevX = CamX; CamPrevY = CamY; CamPrevZ = CamZ;

	const double FwdX = ZR::Sin(Cur.Yaw);
	const double FwdZ = ZR::Cos(Cur.Yaw);
	const double Speed = FMath::Sqrt(Cur.VX * Cur.VX + Cur.VZ * Cur.VZ);

	const double Back = 6.2 + Speed * 0.06;
	const double TX = Cur.X - FwdX * Back;
	const double TZ = Cur.Z - FwdZ * Back;
	double TY = Cur.Y + 2.9;

	// Keep the camera above the terrain behind the rider.
	const double GY = ZR::HeightAt(*World, TX, TZ) + 1.1;
	if (TY < GY) TY = GY;

	if (!bCameraSnapped)
	{
		CamX = TX; CamY = TY; CamZ = TZ;
		CamPrevX = CamX; CamPrevY = CamY; CamPrevZ = CamZ;
		bCameraSnapped = true;
	}
	else
	{
		// Horizontal and vertical smoothing use DIFFERENT rates in the
		// original (5.5 vs 4.0) so the camera does not pogo over bumps.
		const double K = FMath::Min(1.0, 5.5 * Dt);
		const double KY = FMath::Min(1.0, 4.0 * Dt);
		CamX += (TX - CamX) * K;
		CamY += (TY - CamY) * KY;
		CamZ += (TZ - CamZ) * K;
	}

	Dip *= FMath::Max(0.0, 1.0 - 6.0 * Dt);
	if (Shake > 0.0) Shake -= Dt;
}

void AZRRiderPawn::ApplyRenderPose(double Alpha)
{
	const double X = FMath::Lerp(Prev.X, Cur.X, Alpha);
	const double Y = FMath::Lerp(Prev.Y, Cur.Y, Alpha);
	const double Z = FMath::Lerp(Prev.Z, Cur.Z, Alpha);
	const double Yaw = LerpAngle(Prev.Yaw, Cur.Yaw, Alpha);
	const double Spin = FMath::Lerp(Prev.Spin, Cur.Spin, Alpha);
	const double Pitch = FMath::Lerp(Prev.Pitch, Cur.Pitch, Alpha);
	const double Lean = FMath::Lerp(Prev.Lean, Cur.Lean, Alpha);
	const double WheelSpin = FMath::Lerp(Prev.WheelSpin, Cur.WheelSpin, Alpha);

	// The rig carries yaw + spin; the camera below carries yaw only, so a 360
	// stays readable instead of whipping the view round with the bike.
	SetActorLocationAndRotation(
		ZRConv::Pos(X, Y, Z),
		FRotator(0.0, ZRConv::YawDeg(Yaw + Spin), 0.0));

	Rig->Pose(WheelSpin, Lean, Pitch, Cur.bOnGround);

	// ---- camera ----
	const double CX = FMath::Lerp(CamPrevX, CamX, Alpha);
	const double CY = FMath::Lerp(CamPrevY, CamY, Alpha);
	const double CZ = FMath::Lerp(CamPrevZ, CamZ, Alpha);

	double SX = 0.0, SY = 0.0;
	if (Shake > 0.0)
	{
		SX = (FMath::FRand() - 0.5) * 0.3 * Shake;
		SY = (FMath::FRand() - 0.5) * 0.3 * Shake;
	}
	else if (Cur.bOffTrail && Cur.bOnGround
		&& CVarReduceMotion.GetValueOnGameThread() == 0
		&& FMath::Sqrt(Cur.VX * Cur.VX + Cur.VZ * Cur.VZ) > 6.0)
	{
		// The browser game suppresses this under prefers-reduced-motion.
		// zr.ReduceMotion is the equivalent here; AZRGameMode sets it from the
		// macOS Reduce Motion accessibility setting at startup.
		SX = (FMath::FRand() - 0.5) * 0.05;
		SY = (FMath::FRand() - 0.5) * 0.05;
	}

	const FVector CamPos = ZRConv::Pos(CX + SX, CY + SY - Dip, CZ);

	const double FwdX = ZR::Sin(Yaw);
	const double FwdZ = ZR::Cos(Yaw);
	const FVector LookAt = ZRConv::Pos(X + FwdX * 6.0, Y + 1.1, Z + FwdZ * 6.0);

	FRotator CamRot = (LookAt - CamPos).Rotation();
	CamRot.Roll = static_cast<double>(CVarCameraRoll.GetValueOnGameThread()) * Lean
		* FMath::RadiansToDegrees(1.0);

	Camera->SetWorldLocationAndRotation(CamPos, CamRot);

	const double Speed = FMath::Sqrt(Cur.VX * Cur.VX + Cur.VZ * Cur.VZ);
	Camera->SetFieldOfView(static_cast<float>(FMath::Min(HFovMax, HFovBase + Speed * 0.85)));
}

void AZRRiderPawn::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	if (!World || !Taken) return;

	AZRPlayerController* PC = Cast<AZRPlayerController>(GetController());

	// Same fixed-step accumulator as js/game3d.js:5206, including the bail-out:
	// five substeps maximum, and if we hit the cap, throw the remainder away
	// rather than spiral into a death loop trying to catch up.
	Accumulator += FMath::Min(0.1, static_cast<double>(DeltaSeconds));
	int32 Steps = 0;
	while (Accumulator >= ZR::DT && Steps < 5)
	{
		if (bSimulating && !Cur.bFinished)
		{
			Prev = Cur;
			const ZR::FInput In = PC ? PC->ConsumeInputForStep(!Cur.bOnGround) : ZR::FInput();
			StepEvents.clear();
			ZR::StepRider(Cur, In, *World, StepEvents, *Taken);

			for (const ZR::FEvent& E : StepEvents)
			{
				Pending.Add(E);
				if (E.Type == ZR::EEvent::Crash) Shake = 0.45;
				if (E.Type == ZR::EEvent::Land && E.bHard) Dip = 0.35;
			}
		}
		AdvanceCamera(ZR::DT);
		Accumulator -= ZR::DT;
		Steps++;
	}
	if (Steps == 5) Accumulator = 0.0;

	// Render between the last two simulation states. The browser game does not
	// need this — it steps at 60 Hz and draws on a 60 Hz vsync. Every current
	// MacBook Pro is 120 Hz, where an un-interpolated 60 Hz transform holds
	// each position for exactly two frames and judders visibly on a fast
	// chase camera.
	ApplyRenderPose(FMath::Clamp(Accumulator / ZR::DT, 0.0, 1.0));
}
