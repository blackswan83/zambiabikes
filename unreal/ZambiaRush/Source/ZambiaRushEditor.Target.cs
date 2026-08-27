using UnrealBuildTool;

public class ZambiaRushEditorTarget : TargetRules
{
	public ZambiaRushEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("ZambiaRush");
	}
}
