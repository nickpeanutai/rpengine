use std::{env, fs};

fn main() {
    let path = env::args().nth(1).expect("output path");
    fs::write(path, rp_engine_core::typescript_contracts()).expect("write TypeScript contracts");
}
