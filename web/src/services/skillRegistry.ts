/** Static skill command argument definition. */
export interface SkillCommandArg {
  name: string;
  required: boolean;
  default?: string;
  description?: string;
}

/** Static skill command definition. */
export interface SkillCommand {
  id: string;
  label: string;
  description?: string;
  args?: SkillCommandArg[];
  projectLevel: boolean;
}

/** Static skill metadata from the registry. */
export interface SkillMeta {
  id: string;
  npmPackage: string;
  name: string;
  description: string;
  binary: string;
  commands: SkillCommand[];
}

/** Runtime skill info returned from the API. */
export interface SkillInfo extends SkillMeta {
  installed: boolean;
  currentVersion?: string;
  latestVersion?: string;
  updateAvailable: boolean;
  running: boolean;
}

/** Result of a skill install/upgrade operation. */
export interface SkillInstallResult {
  success: boolean;
  version?: string;
  error?: string;
  noNode?: boolean;
}

/** Result of running a skill command. */
export interface SkillRunResult {
  success: boolean;
  output?: string;
  error?: string;
}

/** Response from the skills list endpoint. */
export interface SkillListResponse {
  skills: SkillInfo[];
  noNode: boolean;
  message: string;
}
