# iBlue Open Absinthe overlay

This rustpush overlay offers two mutually exclusive NAC (Network Attestation
Check) backends:

- `native-nac` uses Apple's `AAAbsintheContext` framework on macOS 13+.
- `native-nac-rust` emulates the x86_64 NAC entry points with Unicorn on a
  portable host and supplies hardware data extracted from a real Mac.

The portable backend does not contain, redistribute, or download Apple's
`IMDAppleServices` binary. The operator must set `IBLUE_NAC_BINARY_FILE` to a
read-only copy obtained from Apple software. The backend accepts only the exact
binary supported by its fixed function offsets, identified by SHA-256
`74c2a8fe826a478f14f6e17b3709a8b315e8c0e0e34e3fba6b9c4eee2f4516e9`.

The emulator is derived from the SSPL-licensed rustpush implementation in
`mackid1993/imessage-cleanup` commit
`4f9cdfdf83080439fe2021f54bce305165483329`, itself based on the pypush NAC
approach. iBlue removes automatic binary download, extracted XNU enrichment,
and unique hardware identifiers from logs.
