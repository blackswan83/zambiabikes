#pragma once

#include "CoreMinimal.h"
#include "Components/SynthComponent.h"
#include "HAL/CriticalSection.h"
#include "ZRSynth.generated.h"

/**
 * Every sound in the game, synthesised.
 *
 * The browser game ships no audio files: it has a small Web Audio synth and
 * every effect is one to four oscillators (js/game3d.js:107-161). This is the
 * same idea through USynthComponent::OnGenerateAudio — which is also the only
 * zero-asset route, since Metasounds and Sound Cues are both .uasset.
 *
 * Voices are pushed from the game thread and consumed on the audio render
 * thread, hence the lock. The queue is tiny and contended for microseconds.
 */
UCLASS(ClassGroup = (Audio), meta = (BlueprintSpawnableComponent))
class UZRSynth : public USynthComponent
{
	GENERATED_BODY()

public:
	enum class EWave : uint8 { Sine, Square, Saw, Triangle, Noise };

	/** Matches the browser game's tone(freq, dur, type, delay, freqEnd). */
	void Tone(float Freq, float DurationSec, EWave Wave,
	          float DelaySec = 0.0f, float FreqEnd = -1.0f, float Gain = 1.0f);

	// The named effects, so callers do not have to remember frequencies.
	void PlayCoin();
	void PlayHop();
	void PlayLand(bool bHard);
	void PlayCrash();
	void PlayGate();
	void PlayTurboOn();
	void PlayTrick();
	void PlayFinish();

protected:
	virtual bool Init(int32& SampleRate) override;
	virtual int32 OnGenerateAudio(float* OutAudio, int32 NumSamples) override;

private:
	struct FVoice
	{
		float Freq = 440.0f;
		float FreqEnd = -1.0f;
		float Gain = 1.0f;
		float Phase = 0.0f;
		double Elapsed = 0.0;
		double Delay = 0.0;
		double Duration = 0.2;
		EWave Wave = EWave::Sine;
		bool bActive = false;
	};

	static constexpr int32 MaxVoices = 24;
	FVoice Voices[MaxVoices];
	FCriticalSection VoiceLock;

	int32 Rate = 48000;
	uint32 NoiseState = 0x9E3779B9u;

	/** js/game3d.js: masterGain = 0.15. Children, headphones, small speakers. */
	static constexpr float MasterGain = 0.15f;
};
