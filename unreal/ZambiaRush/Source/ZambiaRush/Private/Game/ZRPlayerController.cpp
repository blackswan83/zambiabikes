#include "ZRPlayerController.h"

#include "GameFramework/InputSettings.h"

AZRPlayerController::AZRPlayerController()
{
	bShowMouseCursor = false;
}

bool AZRPlayerController::InputKey(const FInputKeyEventArgs& Params)
{
	const FKey K = Params.Key;
	const bool bDown = (Params.Event == IE_Pressed);
	const bool bUp = (Params.Event == IE_Released);

	// Auto-repeat (IE_Repeat) is deliberately ignored: holding a key must not
	// register as tapping it.
	if (!bDown && !bUp)
	{
		return Super::InputKey(Params);
	}

	bool bHandled = true;

	if (K == EKeys::W || K == EKeys::Up || K == EKeys::Gamepad_RightShoulder)
	{
		bPedal = bDown;
	}
	else if (K == EKeys::S || K == EKeys::Down || K == EKeys::Gamepad_LeftShoulder)
	{
		bBrake = bDown;
	}
	else if (K == EKeys::A || K == EKeys::Left || K == EKeys::Gamepad_DPad_Left)
	{
		bLeft = bDown;
	}
	else if (K == EKeys::D || K == EKeys::Right || K == EKeys::Gamepad_DPad_Right)
	{
		bRight = bDown;
	}
	else if (K == EKeys::SpaceBar || K == EKeys::Gamepad_FaceButton_Bottom)
	{
		// Held, not queued: ZRCore rate-limits hops with a 0.55 s cooldown, so
		// holding the key bunny-hops repeatedly, which is what the browser
		// game does.
		bHop = bDown;
	}
	else if (K == EKeys::K || K == EKeys::Gamepad_FaceButton_Right)
	{
		if (bDown)
		{
			TurboTaps++;
		}
	}
	else if (K == EKeys::Escape || K == EKeys::P || K == EKeys::Gamepad_Special_Right)
	{
		if (bDown) bPauseRequested = true;
	}
	else
	{
		bHandled = false;
	}

	if (bHandled)
	{
		return true;
	}
	return Super::InputKey(Params);
}

ZR::FInput AZRPlayerController::ConsumeInputForStep(bool bAloft)
{
	ZR::FInput In;
	In.bPedal = bPedal;
	In.bBrake = bBrake;
	In.bLeft = bLeft;
	In.bRight = bRight;
	In.bHop = bHop;

	In.bTurbo = TurboTaps > 0;
	if (In.bTurbo)
	{
		TurboTaps--;
	}

	// In the air the same four keys mean tricks instead of riding
	// (js/game3d.js:5297). Tricks never touch velocity or heading, so this
	// costs the rider nothing in the air and the AI, which never sets them,
	// is unaffected.
	In.bFlipF = bAloft && In.bPedal;
	In.bFlipB = bAloft && In.bBrake;
	In.bSpinL = bAloft && In.bLeft;
	In.bSpinR = bAloft && In.bRight;

	return In;
}

void AZRPlayerController::ResetInput()
{
	bPedal = bBrake = bLeft = bRight = bHop = false;
	TurboTaps = 0;
	bPauseRequested = false;
}

bool AZRPlayerController::ConsumePauseRequest()
{
	const bool bWas = bPauseRequested;
	bPauseRequested = false;
	return bWas;
}
