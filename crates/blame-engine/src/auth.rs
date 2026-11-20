//! `auth chatgpt …`: signing in to a ChatGPT subscription on the user's
//! machine, for the desktop app to keep the tokens (in the OS keychain) and
//! hand them to engines through `host/credential`. Nothing is stored here.
//!
//! Stdout carries JSON lines: for a sign-in, first what the user must do
//! (`{"authorize_url": …}` to open, or `{"verification_uri": …,
//! "user_code": …}` to enter), and the tokens as the last line.

use crate::options;
use blame_engine_providers::chatgpt::{
    self, LoginConfig, LoginError, refresh, start_browser_login, start_device_login,
};
use serde_json::json;
use std::io::{BufRead, Write};

fn config(auth_base: Option<&str>) -> LoginConfig {
    let mut config = LoginConfig::default();
    if let Some(base) = auth_base {
        config.auth_base = base.trim_end_matches('/').to_owned();
    }
    config
}

fn line(value: &serde_json::Value) -> Result<(), String> {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{value}")
        .and_then(|()| out.flush())
        .map_err(|error| error.to_string())
}

fn tokens(tokens: &chatgpt::Tokens) -> Result<(), String> {
    line(&serde_json::to_value(tokens).map_err(|error| error.to_string())?)
}

fn failed(error: LoginError) -> String {
    match error {
        LoginError::Reauthenticate => "reauthenticate: the ChatGPT sign-in has expired".into(),
        other => other.to_string(),
    }
}

pub struct Login {
    device: bool,
    auth_base: Option<String>,
}

impl Login {
    pub fn parse(args: &[&str]) -> Result<Self, String> {
        let mut login = Self {
            device: false,
            auth_base: None,
        };
        for (name, value) in options(args, &["--auth-base"], &["--device"])? {
            match name.as_str() {
                "--device" => login.device = true,
                _ => login.auth_base = value.map(str::to_owned),
            }
        }
        Ok(login)
    }

    pub async fn run(self) -> Result<(), String> {
        let config = config(self.auth_base.as_deref());
        if !self.device {
            match start_browser_login(&config).await {
                Ok(login) => {
                    line(&json!({ "authorize_url": login.authorize_url() }))?;
                    return tokens(&login.finish().await.map_err(failed)?);
                }
                // Both callback ports are taken (another sign-in, another
                // app): the device code needs no port.
                Err(LoginError::PortsInUse) => {}
                Err(error) => return Err(failed(error)),
            }
        }
        let login = start_device_login(&config).await.map_err(failed)?;
        line(&json!({
            "verification_uri": login.verification_uri(),
            "user_code": login.user_code(),
        }))?;
        tokens(&login.finish().await.map_err(failed)?)
    }
}

pub struct Refresh {
    auth_base: Option<String>,
}

impl Refresh {
    pub fn parse(args: &[&str]) -> Result<Self, String> {
        let mut refresh = Self { auth_base: None };
        for (_, value) in options(args, &["--auth-base"], &[])? {
            refresh.auth_base = value.map(str::to_owned);
        }
        Ok(refresh)
    }

    /// The refresh token is read from stdin: on the command line every user
    /// of the machine could read it.
    pub async fn run(self) -> Result<(), String> {
        let mut token = String::new();
        std::io::stdin()
            .lock()
            .read_line(&mut token)
            .map_err(|error| format!("reading the refresh token: {error}"))?;
        let token = token.trim();
        if token.is_empty() {
            return Err("give the refresh token on stdin".into());
        }
        let config = config(self.auth_base.as_deref());
        tokens(&refresh(&config, token).await.map_err(failed)?)
    }
}
