export type OpenPullRequestResult = {
  url: string;
  // False when an open pull request already existed for the story branch.
  created: boolean;
  targetBranch: string;
};

export type PullRequestAvailabilityInput = {
  repositoryRoot: string;
};

// Whether Open PR can run on this computer for this project.
export type PullRequestAvailability =
  | { status: "available"; repository: string }
  // origin is missing or not on github.com: the action is not offered.
  | { status: "not-github" }
  // gh is missing or signed out: message says what to do.
  | { status: "gh-missing" | "gh-signed-out"; message: string };

export type PullRequestStateInput = {
  repositoryRoot: string;
  // The URL of the pull request opened from the story.
  url: string;
};

// What GitHub says about a story's pull request. Approved is still open: a
// pull request is merged once its code is in the target branch.
export type PullRequestState =
  | { status: "open" }
  | { status: "merged"; mergedAt: string }
  | { status: "closed" }
  // gh is missing, signed out or cannot reach GitHub: nothing is known.
  | { status: "unavailable" };
