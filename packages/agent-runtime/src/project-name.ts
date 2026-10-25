/** Folder-name rules shared by the desktop creator and its browser UI. */
export function projectNameError(projectName: string): string | undefined {
  const name = projectName.trim();
  if (!name) return "Enter a project name.";
  if (/\s/.test(name))
    return "Replace spaces with dashes, for example my-project.";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    return "Start with a letter or number. Use letters, numbers, dots, dashes or underscores, without spaces.";
  }
  if (name.endsWith(".")) return "Project names cannot end with a dot.";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    return "This name is reserved by the operating system. Choose another name.";
  }
  if (name.length > 214)
    return "Use a project name of 214 characters or fewer.";
  return undefined;
}
