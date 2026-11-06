import type { UserInstructionConfigService } from "@cline/sdk";
import {
  createUserInstructionConfigService,
  resolvePluginSkillDirectoriesFromPaths,
} from "@cline/sdk";

type StartUserInstructionServiceInput = {
  cwd: string;
  pluginPaths: string[];
  sessionId: string;
  workspaceRoot: string;
};

type UserInstructionServiceFactory = typeof createUserInstructionConfigService;

// Skills that only apply through a tool the session may not register.
const skillRequiredTools: ReadonlyMap<string, string> = new Map([
  ["component-preview", "open_component_preview"],
]);

export function skillScopeSystemPrompt(
  service?: UserInstructionConfigService,
  toolNames: readonly string[] = [],
) {
  const configured: Array<{ name: string; description?: string; disabled?: boolean }> =
    service?.createSkillsExecutor?.().configuredSkills ?? [];
  const skills = configured.filter(
    (skill) => !skill.disabled && hasRequiredTool(skill.name, toolNames),
  );
  if (!skills.length) return "";
  const descriptions: string[] = [];
  let remaining = 16_384;
  for (const skill of skills) {
    const description = JSON.stringify({
      name: skill.name,
      description: skill.description?.trim() || "Scope unavailable; inspect the skill when relevance is uncertain.",
    });
    if (description.length > remaining) {
      descriptions.push("Further descriptions exceed this snapshot's limit; the skills tool remains available.");
      break;
    }
    descriptions.push(description);
    remaining -= description.length + 1;
  }
  return "\n\n## Skill selection\n" +
    "Invoke explicitly requested skills. Otherwise load a skill when its described scope applies to the current request; frontend files elsewhere in the workspace do not make a backend or mechanical task frontend design work. These descriptions are a startup snapshot; the skills tool loads current instructions. Inspect the skill if relevance is uncertain.\n" +
    descriptions.join("\n");
}

function hasRequiredTool(skillName: string, toolNames: readonly string[]) {
  const tool = skillRequiredTools.get(skillName.trim());
  return !tool || toolNames.includes(tool);
}

export class BlameUserInstructionServices {
  private readonly createService: UserInstructionServiceFactory;
  private readonly services = new Map<string, UserInstructionConfigService>();

  constructor(
    createService: UserInstructionServiceFactory = createUserInstructionConfigService,
  ) {
    this.createService = createService;
  }

  async start(input: StartUserInstructionServiceInput) {
    const service = this.createService({
      skills: {
        workspacePath: input.workspaceRoot,
        pluginSkillDirectories: resolvePluginSkillDirectoriesFromPaths(
          input.pluginPaths,
        ),
      },
      rules: { workspacePath: input.cwd },
      workflows: { workspacePath: input.cwd },
    });
    try {
      await service.start();
    } catch {
      service.stop();
      return undefined;
    }
    this.stop(input.sessionId);
    this.services.set(input.sessionId, service);
    return service;
  }

  stop(sessionId: string) {
    this.services.get(sessionId)?.stop();
    this.services.delete(sessionId);
  }

  stopAll() {
    this.services.forEach((service) => service.stop());
    this.services.clear();
  }
}
