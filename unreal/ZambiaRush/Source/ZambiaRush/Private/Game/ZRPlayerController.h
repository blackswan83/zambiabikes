#pragma once

#include "CoreMinimal.h"
#include "GameFramework/PlayerController.h"
#include "Core/ZRCore.h"
#include "ZRPlayerController.generated.h"

/**
 * Reads the keyboard and gamepad without a single input asset.
 *
 * WHY NOT ENHANCED INPUT: turbo is tap-RATE driven. One press opens a
 * ten-second window, and the throttle then tracks how fast you tap
 * (taps/sec x 0.10 / 0.8, so ~4 taps/s is half throttle and ~8 is full).
 * Enhanced Input's ETriggerEvent::Started fires at most once per frame per
 * action, so it structurally cannot count taps — two presses inside one frame
 * become one. Legacy axis mappings have the same problem and are gone in 5.8
 * anyway.
 *
 * APlayerController::InputKey is called once per OS key event, so nothing is
 * lost, and IE_Repeat arrives as its own event so OS auto-repeat filters out
 * for free — which is exactly what the browser game does with
 * `if (e.repeat) return` (js/game3d.js:231) and its turboTaps queue
 * (js/game3d.js:174, 244, 5295).
 */
UCLASS()
class AZRPlayerController : public APlayerController
{
	GENERATED_BODY()

public:
	AZRPlayerController();

	virtual bool InputKey(const FInputKeyEventArgs& Params) override;

	/**
	 * Builds one fixed step's input and drains ONE queued turbo tap, exactly
	 * as the browser game's loop does. Must be called once per simulation
	 * step, not once per frame — at 120 Hz on a ProMotion display those are
	 * different numbers.
	 */
	ZR::FInput ConsumeInputForStep(bool bAloft);

	/** Clears held keys and the tap queue, e.g. on countdown or restart. */
	void ResetInput();

	/** True on the frame the player asked to pause. Consumes the request. */
	bool ConsumePauseRequest();

private:
	bool bPedal = false;
	bool bBrake = false;
	bool bLeft = false;
	bool bRight = false;
	bool bHop = false;

	/** Queued, never sampled. See the class comment. */
	int32 TurboTaps = 0;
	bool bPauseRequested = false;
};
