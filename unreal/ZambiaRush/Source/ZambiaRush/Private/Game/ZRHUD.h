#pragma once

#include "CoreMinimal.h"
#include "GameFramework/HUD.h"
#include "ZRHUD.generated.h"

/**
 * The HUD, drawn straight onto the Canvas.
 *
 * UMG would mean .uasset widgets, which this project deliberately does not
 * have. The HUD is small enough that it does not matter: time, coins, km/h, a
 * turbo panel, a progress bar, a trick toast and a results card — the same
 * set the browser game shows (game.html:96-112).
 *
 * Text goes through FSlateFontInfo rather than GEngine->GetLargeFont(). The
 * engine's large font is a fixed-size bitmap, and a countdown "3" scaled up
 * six times from it looks like a mistake; Slate's font cache renders Roboto
 * as vectors at any size and is always staged.
 */
UCLASS()
class AZRHUD : public AHUD
{
	GENERATED_BODY()

public:
	virtual void DrawHUD() override;

private:
	void DrawChip(float X, float Y, const FText& Label, float FontSize = 22.0f);
	void DrawTurbo(class AZRGameMode* GM, float Right, float Bottom);
	void DrawProgress(class AZRGameMode* GM, float Width, float Bottom);
	void DrawResults(class AZRGameMode* GM, float Width, float Height);

	float ChipCursor = 0.0f;
};
