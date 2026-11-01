//! Run a local classifier against already serialized text.
use anyhow::{Context, Result};
use liquid_guardian::Guardian;
use std::path::Path;

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let folder = args.next().context("usage: score MODEL_FOLDER TEXT")?;
    let text = args.next().context("usage: score MODEL_FOLDER TEXT")?;
    let guardian = Guardian::load(Path::new(&folder))?;
    println!("{}", guardian.score(&text)?);
    Ok(())
}
