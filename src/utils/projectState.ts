import type { VideoProject } from "../types";

export function hasGeneratedProject(
  project: VideoProject | null | undefined
): project is VideoProject {
  return Boolean(project && !project.isDraft);
}

export function hasProjectMedia(
  project: VideoProject | null | undefined
): project is VideoProject {
  return Boolean(project);
}
