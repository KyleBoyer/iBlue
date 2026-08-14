fn main() {
    // Gate on the TARGET os, not the host: a build script is compiled for the
    // host, so #[cfg(target_os)] would be macOS even when cross-building to Linux.
    // CARGO_CFG_TARGET_OS is the real target.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "macos" {
        // `cc` does not reliably invalidate this build script when an
        // Objective-C source changes.
        println!("cargo:rerun-if-changed=src/hardware_info.m");
        println!("cargo:rerun-if-changed=src/evs_encoder.m");
        println!("cargo:rerun-if-changed=src/evs_encoder.h");
        println!("cargo:rerun-if-changed=src/aac_eld_encoder.m");
        println!("cargo:rerun-if-changed=src/aac_eld_encoder.h");
        // Compile the Objective-C hardware info reader (macOS only).
        cc::Build::new()
            .file("src/hardware_info.m")
            .flag("-fobjc-arc")
            .flag("-framework")
            .flag("Foundation")
            .flag("-framework")
            .flag("IOKit")
            .compile("hardware_info");

        // Compile the private AVConference EVS shim used by native FaceTime
        // audio. It resolves AVConference dynamically so the binary still
        // starts cleanly on macOS versions where the private codec differs.
        cc::Build::new()
            .file("src/evs_encoder.m")
            .flag("-fobjc-arc")
            .flag("-framework")
            .flag("Foundation")
            .flag("-framework")
            .flag("AudioToolbox")
            .compile("evs_encoder");

        // Stateful public AudioToolbox AAC-ELD encoder used by the verified
        // PT104 live-audio path.
        cc::Build::new()
            .file("src/aac_eld_encoder.m")
            .flag("-fobjc-arc")
            .flag("-framework")
            .flag("Foundation")
            .flag("-framework")
            .flag("AudioToolbox")
            .compile("aac_eld_encoder");

        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=IOKit");
        println!("cargo:rustc-link-lib=framework=AudioToolbox");
    }
}
