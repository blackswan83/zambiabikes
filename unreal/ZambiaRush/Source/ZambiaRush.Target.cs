using UnrealBuildTool;

public class ZambiaRushTarget : TargetRules
{
	public ZambiaRushTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("ZambiaRush");
	}
}
