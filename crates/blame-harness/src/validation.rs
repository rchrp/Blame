//! Content validation of a final edit (`content-validation.ts`). Languages
//! parsed with ast-grep are validated here; TypeScript, JSONC and Prisma go
//! to the compiler side process, which runs `validateContent` itself.
//! Without it they are reported unsupported, so the edit's parse status says
//! unsupported rather than passed.

use crate::compiler::CompilerPort;
use crate::failure::{Outcome, Signal};
use crate::json::Json;
use crate::languages::{ValidatorId, language_capability};
use crate::obj;
use crate::syntax::{parse_code, parse_syntax_diagnostics};

pub struct ContentValidation {
    pub status: String,
    pub validator: Option<String>,
    pub diagnostics: Vec<String>,
}

fn validation(
    status: &str,
    validator: Option<&str>,
    diagnostics: Vec<String>,
) -> ContentValidation {
    ContentValidation {
        status: status.into(),
        validator: validator.map(str::to_string),
        diagnostics,
    }
}

pub fn validate_content(
    compiler: &dyn CompilerPort,
    root: &str,
    path: &str,
    content: Option<&[u8]>,
    external: &str,
    signal: &Signal,
) -> Outcome<ContentValidation> {
    let Some(content) = content else {
        return Ok(validation("unsupported", None, Vec::new()));
    };
    match language_capability(path, Some(content)).validator_id {
        Some(ValidatorId::SemanticParser) => Ok(validate_semantic(path, content)),
        Some(ValidatorId::Jsonc | ValidatorId::Prisma | ValidatorId::Typescript) => {
            let reply = compiler.validate(root, path, Some(content), Some(external), signal)?;
            Ok(match reply {
                Some(reply) => ContentValidation {
                    status: reply
                        .get("status")
                        .and_then(Json::as_str)
                        .unwrap_or("unsupported")
                        .to_string(),
                    validator: reply
                        .get("validator")
                        .and_then(Json::as_str)
                        .map(str::to_string),
                    diagnostics: reply
                        .get("diagnostics")
                        .and_then(Json::as_array)
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(|item| item.as_str().map(str::to_string))
                                .collect()
                        })
                        .unwrap_or_default(),
                },
                None => validation("unsupported", None, Vec::new()),
            })
        }
        None => Ok(validation("unsupported", None, Vec::new())),
    }
}

fn validate_semantic(path: &str, content: &[u8]) -> ContentValidation {
    let parsed = parse_code(path, content);
    if !parsed.supported {
        return validation("unsupported", None, Vec::new());
    }
    if parsed.language == "c" || parsed.language == "cpp" {
        return validation(
            "unsupported",
            Some("ast-grep"),
            vec![
                "C/C++ syntax requires the project compiler and preprocessing configuration."
                    .into(),
            ],
        );
    }
    let status = if parsed.error_count > 0 {
        "failed"
    } else {
        "passed"
    };
    validation(
        status,
        Some("ast-grep"),
        parse_syntax_diagnostics(&parsed, content),
    )
}

impl ContentValidation {
    pub fn to_json(&self, path: &str) -> Json {
        obj! {
            "path" => path,
            "status" => self.status.as_str(),
            "validator" => self.validator.as_deref().map_or(Json::Null, Json::from),
            "diagnostics" => Json::Arr(self.diagnostics.iter().map(Json::from).collect()),
        }
    }
}
