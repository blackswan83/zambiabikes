using UnrealBuildTool;
using System.IO;

public class ZambiaRush : ModuleRules
{
	public ZambiaRush(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new string[]
		{
			"Core",
			"CoreUObject",
			"Engine",
			"InputCore",
			"ProceduralMeshComponent",
			"AudioMixer",
		});

		PrivateIncludePaths.Add(Path.Combine(ModuleDirectory, "Private"));

		// ZRCore and ZRMath reproduce JavaScript's floating-point results
		// bit-for-bit. Both of the settings below are load-bearing for that:
		//
		//   FPSemantics.Precise  stops the compiler contracting `a*b + c` into
		//                        an FMA, which rounds once instead of twice.
		//                        Three of Miombo's four FBM octave seeds are
		//                        sensitive to this.
		//   bUseUnity = false    keeps ZRCore.cpp a translation unit of its
		//                        own so its `#pragma clang fp contract(off)`
		//                        cannot be perturbed by whatever it would
		//                        otherwise be glued to, and so a missing
		//                        include fails now rather than later.
		//
		// Tools/verify.sh will tell you immediately if either stops working.
		FPSemantics = FPSemanticsMode.Precise;
		bUseUnity = false;
	}
}
