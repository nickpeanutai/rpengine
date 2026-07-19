mod audio;
mod app;
mod contract;
mod json_core;
mod prompt;
mod session;
mod settings;
mod text;
mod vad;
mod worker;

pub use audio::*;
pub use app::*;
pub use contract::*;
pub use json_core::*;
pub use prompt::*;
pub use session::*;
pub use settings::*;
pub use text::*;
pub use vad::*;
pub use worker::*;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn core_abi_version() -> u32 { 3 }

fn js_error(error: impl ToString) -> JsError { JsError::new(&error.to_string()) }
