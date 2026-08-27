#include "ZRHUD.h"

#include "Core/ZRCore.h"
#include "Engine/Canvas.h"
#include "Engine/Engine.h"
#include "Game/ZRConvert.h"
#include "Game/ZRGameMode.h"
#include "Game/ZRRiderPawn.h"
#include "Kismet/GameplayStatics.h"
#include "Styling/CoreStyle.h"

namespace
{
	// css/styles.css :root
	const FLinearColor Paper  = FLinearColor::FromSRGBColor(FColor(0xFF, 0xF9, 0xEE));
	const FLinearColor Ink    = FLinearColor::FromSRGBColor(FColor(0x2B, 0x1B, 0x10));
	const FLinearColor Copper = FLinearColor::FromSRGBColor(FColor(0xE8, 0x79, 0x1D));
	const FLinearColor Forest = FLinearColor::FromSRGBColor(FColor(0x1F, 0x7A, 0x48));
	const FLinearColor Sun    = FLinearColor::FromSRGBColor(FColor(0xF7, 0xB7, 0x33));
	const FLinearColor River  = FLinearColor::FromSRGBColor(FColor(0x2A, 0x9D, 0x8F));
	const FLinearColor Flame  = FLinearColor::FromSRGBColor(FColor(0xD6, 0x45, 0x33));

	FSlateFontInfo Font(float Size)
	{
		return FCoreStyle::GetDefaultFontStyle("Bold", static_cast<int32>(Size));
	}

	FString FormatClock(double Seconds)
	{
		if (Seconds < 0) Seconds = 0;
		const int32 Mins = FMath::FloorToInt32(Seconds / 60.0);
		const double Rem = Seconds - Mins * 60.0;
		return FString::Printf(TEXT("%d:%04.1f"), Mins, Rem);
	}
}

void AZRHUD::DrawChip(float X, float Y, const FText& Label, float FontSize)
{
	const FSlateFontInfo F = Font(FontSize);
	float TW = 0.0f, TH = 0.0f;
	Canvas->TextSize(GEngine->GetMediumFont(), Label.ToString(), TW, TH, 1.0f, 1.0f);
	// TextSize with the engine font is only an estimate for a Slate-rendered
	// string; pad generously rather than clip.
	const float W = FMath::Max(TW * (FontSize / 14.0f), 60.0f) + 26.0f;
	const float H = FontSize + 16.0f;

	DrawRect(FLinearColor(Ink.R, Ink.G, Ink.B, 0.55f), X, Y, W, H);
	FCanvasTextItem Item(FVector2D(X + 13.0f, Y + 8.0f), Label, F, Paper);
	Item.EnableShadow(FLinearColor(0, 0, 0, 0.5f));
	Canvas->DrawItem(Item);

	ChipCursor = X + W + 10.0f;
}

void AZRHUD::DrawTurbo(AZRGameMode* GM, float Right, float Bottom)
{
	const ZR::FRiderState& St = GM->Rider()->State();

	const float W = 260.0f, H = 12.0f;
	const float X = Right - W - 28.0f;
	const float Y = Bottom - 92.0f;

	FString Label;
	FLinearColor Bar = Copper;
	double Fill = 0.0;

	if (St.TurboT > 0.0)
	{
		Label = FString::Printf(TEXT("TURBO  tap K   %.0f%%"), St.Throttle * 100.0);
		Fill = St.Throttle;
		Bar = Sun;
	}
	else if (St.TurboCd > 0.0)
	{
		Label = FString::Printf(TEXT("Turbo recharging  %.0fs"), St.TurboCd);
		Fill = 1.0 - (St.TurboCd / (ZR::TURBO_COOLDOWN * St.Stats.TurboCool));
		Bar = FLinearColor(0.45f, 0.4f, 0.36f, 1.0f);
	}
	else
	{
		Label = TEXT("Turbo ready - press K, then tap fast");
		Fill = 1.0;
		Bar = Forest;
	}

	FCanvasTextItem Item(FVector2D(X, Y - 26.0f), FText::FromString(Label), Font(16.0f), Paper);
	Item.EnableShadow(FLinearColor(0, 0, 0, 0.5f));
	Canvas->DrawItem(Item);

	DrawRect(FLinearColor(Ink.R, Ink.G, Ink.B, 0.55f), X, Y, W, H);
	DrawRect(Bar, X, Y, W * static_cast<float>(FMath::Clamp(Fill, 0.0, 1.0)), H);
}

void AZRHUD::DrawProgress(AZRGameMode* GM, float Width, float Bottom)
{
	const ZR::FWorld& W = GM->World();
	const double Frac = W.FinishIdx > 0
		? FMath::Clamp(static_cast<double>(GM->Rider()->State().TrailIdx) / W.FinishIdx, 0.0, 1.0)
		: 0.0;

	const float BarW = Width - 56.0f;
	const float X = 28.0f;
	const float Y = Bottom - 44.0f;

	DrawRect(FLinearColor(Ink.R, Ink.G, Ink.B, 0.45f), X, Y, BarW, 8.0f);
	DrawRect(River, X, Y, BarW * static_cast<float>(Frac), 8.0f);
	DrawRect(Paper, X + BarW * static_cast<float>(Frac) - 2.0f, Y - 5.0f, 4.0f, 18.0f);
}

void AZRHUD::DrawResults(AZRGameMode* GM, float Width, float Height)
{
	const float BoxW = 520.0f, BoxH = 300.0f;
	const float X = (Width - BoxW) * 0.5f;
	const float Y = (Height - BoxH) * 0.5f;

	DrawRect(FLinearColor(Ink.R, Ink.G, Ink.B, 0.88f), X, Y, BoxW, BoxH);

	const ZR::FRiderState& St = GM->Rider()->State();

	FText MedalText;
	FLinearColor MedalColour = Paper;
	switch (GM->Medal())
	{
	case EZRMedal::Gold:   MedalText = FText::FromString(TEXT("GOLD - you beat Armand"));  MedalColour = Sun;    break;
	case EZRMedal::Silver: MedalText = FText::FromString(TEXT("SILVER"));                  MedalColour = Paper;  break;
	case EZRMedal::Bronze: MedalText = FText::FromString(TEXT("BRONZE"));                  MedalColour = Copper; break;
	default:               MedalText = FText::FromString(TEXT("Finished"));                MedalColour = Paper;  break;
	}

	auto Line = [&](float DY, const FString& S, float Size, const FLinearColor& C)
	{
		FCanvasTextItem I(FVector2D(X + 34.0f, Y + DY), FText::FromString(S), Font(Size), C);
		Canvas->DrawItem(I);
	};

	Line(28.0f,  MedalText.ToString(), 34.0f, MedalColour);
	Line(88.0f,  FString::Printf(TEXT("Time      %s"), *FormatClock(GM->FinalTimeMs() / 1000.0)), 24.0f, Paper);
	Line(124.0f, FString::Printf(TEXT("Score     %d"), St.Score), 24.0f, Paper);
	Line(160.0f, FString::Printf(TEXT("Coins     %d"), St.CoinCount), 24.0f, Paper);
	Line(196.0f, FString::Printf(TEXT("Crashes   %d"), St.Crashes), 24.0f, Paper);
	Line(240.0f, FString::Printf(TEXT("Gold %s     Silver %s"),
		*FormatClock(GM->GoldMs() / 1000.0), *FormatClock(GM->SilverMs() / 1000.0)), 18.0f,
		FLinearColor(0.75f, 0.72f, 0.68f, 1.0f));
}

void AZRHUD::DrawHUD()
{
	Super::DrawHUD();

	AZRGameMode* GM = Cast<AZRGameMode>(UGameplayStatics::GetGameMode(this));
	if (!GM || !GM->Rider() || !Canvas) return;

	const float Width = Canvas->ClipX;
	const float Height = Canvas->ClipY;
	const ZR::FRiderState& St = GM->Rider()->State();

	// ---- top chips: time, coins, speed ----
	ChipCursor = 28.0f;
	DrawChip(ChipCursor, 24.0f, FText::FromString(FormatClock(St.T)));
	DrawChip(ChipCursor, 24.0f, FText::FromString(FString::Printf(TEXT("%d coins"), St.CoinCount)));
	const double Speed = FMath::Sqrt(St.VX * St.VX + St.VZ * St.VZ) * 3.6;
	DrawChip(ChipCursor, 24.0f, FText::FromString(FString::Printf(TEXT("%.0f km/h"), Speed)));
	DrawChip(ChipCursor, 24.0f, FText::FromString(FString::Printf(TEXT("%d pts"), St.Score)));

	DrawTurbo(GM, Width, Height);
	DrawProgress(GM, Width, Height);

	// ---- trick toast ----
	if (GM->ToastRemaining() > 0.0)
	{
		const float Alpha = static_cast<float>(FMath::Clamp(GM->ToastRemaining(), 0.0, 1.0));
		FCanvasTextItem Item(FVector2D(Width * 0.5f - 120.0f, Height * 0.34f),
			GM->TrickToast(), Font(34.0f), FLinearColor(Sun.R, Sun.G, Sun.B, Alpha));
		Item.EnableShadow(FLinearColor(0, 0, 0, 0.6f * Alpha));
		Canvas->DrawItem(Item);
	}

	// ---- countdown ----
	if (GM->RaceState() == EZRRaceState::Countdown)
	{
		const int32 N = FMath::CeilToInt32(GM->CountdownRemaining());
		FCanvasTextItem Item(FVector2D(Width * 0.5f - 26.0f, Height * 0.4f),
			FText::AsNumber(FMath::Max(1, N)), Font(120.0f), Paper);
		Item.EnableShadow(FLinearColor(0, 0, 0, 0.6f));
		Canvas->DrawItem(Item);
	}
	else if (GM->GoBannerRemaining() > 0.0)
	{
		FCanvasTextItem Item(FVector2D(Width * 0.5f - 70.0f, Height * 0.4f),
			FText::FromString(TEXT("GO!")), Font(110.0f), Forest);
		Item.EnableShadow(FLinearColor(0, 0, 0, 0.6f));
		Canvas->DrawItem(Item);
	}

	if (GM->RaceState() == EZRRaceState::Finished)
	{
		DrawResults(GM, Width, Height);
	}
}
