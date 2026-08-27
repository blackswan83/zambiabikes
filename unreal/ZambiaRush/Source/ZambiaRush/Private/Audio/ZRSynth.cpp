#include "ZRSynth.h"

bool UZRSynth::Init(int32& SampleRate)
{
	NumChannels = 1;
	Rate = SampleRate;
	return true;
}

void UZRSynth::Tone(float Freq, float DurationSec, EWave Wave,
                    float DelaySec, float FreqEnd, float Gain)
{
	FScopeLock Lock(&VoiceLock);
	for (int32 I = 0; I < MaxVoices; I++)
	{
		if (Voices[I].bActive) continue;
		FVoice& V = Voices[I];
		V.Freq = Freq;
		V.FreqEnd = FreqEnd;
		V.Gain = Gain;
		V.Phase = 0.0f;
		V.Elapsed = 0.0;
		V.Delay = DelaySec;
		V.Duration = DurationSec;
		V.Wave = Wave;
		V.bActive = true;
		return;
	}
	// Out of voices: drop it. Better a missing coin ping than a stolen crash.
}

int32 UZRSynth::OnGenerateAudio(float* OutAudio, int32 NumSamples)
{
	const double Dt = 1.0 / static_cast<double>(Rate);
	FMemory::Memzero(OutAudio, NumSamples * sizeof(float));

	FScopeLock Lock(&VoiceLock);
	for (int32 VI = 0; VI < MaxVoices; VI++)
	{
		FVoice& V = Voices[VI];
		if (!V.bActive) continue;

		for (int32 S = 0; S < NumSamples; S++)
		{
			if (V.Delay > 0.0) { V.Delay -= Dt; continue; }
			if (V.Elapsed >= V.Duration) { V.bActive = false; break; }

			const float T = static_cast<float>(V.Elapsed / V.Duration);

			// A plain exponential decay, like the Web Audio gain ramp the
			// browser game uses. No attack: these are all percussive.
			const float Env = FMath::Exp(-4.0f * T);

			const float F = V.FreqEnd >= 0.0f ? FMath::Lerp(V.Freq, V.FreqEnd, T) : V.Freq;
			V.Phase += static_cast<float>(F * Dt);
			if (V.Phase >= 1.0f) V.Phase -= FMath::FloorToFloat(V.Phase);

			float Sample = 0.0f;
			switch (V.Wave)
			{
			case EWave::Sine:     Sample = FMath::Sin(2.0f * PI * V.Phase); break;
			case EWave::Square:   Sample = V.Phase < 0.5f ? 1.0f : -1.0f; break;
			case EWave::Saw:      Sample = 2.0f * V.Phase - 1.0f; break;
			case EWave::Triangle: Sample = 4.0f * FMath::Abs(V.Phase - 0.5f) - 1.0f; break;
			case EWave::Noise:
				NoiseState = NoiseState * 1664525u + 1013904223u;
				Sample = (static_cast<float>(NoiseState >> 8) / 8388608.0f) - 1.0f;
				break;
			}

			OutAudio[S] += Sample * Env * V.Gain * MasterGain;
			V.Elapsed += Dt;
		}
	}

	// Cheap limiter: several voices at once should not clip.
	for (int32 S = 0; S < NumSamples; S++)
	{
		OutAudio[S] = FMath::Clamp(OutAudio[S], -1.0f, 1.0f);
	}
	return NumSamples;
}

// ---- the named effects, transcribed from js/game3d.js:107-161 ----

void UZRSynth::PlayCoin()
{
	Tone(980.0f, 0.09f, EWave::Square);
	Tone(1470.0f, 0.12f, EWave::Square, 0.06f);
}

void UZRSynth::PlayHop()
{
	Tone(320.0f, 0.10f, EWave::Triangle, 0.0f, 520.0f);
}

void UZRSynth::PlayLand(bool bHard)
{
	Tone(bHard ? 130.0f : 190.0f, bHard ? 0.16f : 0.08f, EWave::Triangle, 0.0f,
	     bHard ? 70.0f : 140.0f, bHard ? 1.0f : 0.6f);
}

void UZRSynth::PlayCrash()
{
	Tone(300.0f, 0.35f, EWave::Saw, 0.0f, 60.0f);
	Tone(90.0f, 0.30f, EWave::Noise, 0.0f, -1.0f, 0.5f);
}

void UZRSynth::PlayGate()
{
	Tone(680.0f, 0.07f, EWave::Sine);
}

void UZRSynth::PlayTurboOn()
{
	Tone(220.0f, 0.22f, EWave::Saw, 0.0f, 660.0f, 0.8f);
}

void UZRSynth::PlayTrick()
{
	Tone(660.0f, 0.10f, EWave::Triangle);
	Tone(880.0f, 0.12f, EWave::Triangle, 0.07f);
	Tone(1320.0f, 0.16f, EWave::Triangle, 0.14f);
}

void UZRSynth::PlayFinish()
{
	const float Notes[4] = { 523.0f, 659.0f, 784.0f, 1047.0f };
	for (int32 I = 0; I < 4; I++)
	{
		Tone(Notes[I], 0.16f, EWave::Triangle, I * 0.12f);
	}
}
