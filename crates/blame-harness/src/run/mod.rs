//! `run_task`: project tasks and literal commands in the workspace, their
//! output, the changes they make and the checks they prove
//! (`light-task-runner.ts` and the modules it uses).

pub mod catalog;
pub mod changes;
pub mod check;
pub mod dependency;
pub mod environment;
pub mod failure;
pub mod formatter;
pub mod inspection;
pub mod managed;
pub mod output;
pub mod policy;
pub mod process;
pub mod report;
pub mod runner;
pub mod shell_words;
