# AI disclosure

This project is written with substantial assistance from an AI coding agent running inside DeepSeek Harness.

What that means concretely:

- The implementation, this documentation, and the commit history were produced in a human–agent dialogue.
- Every claimed behaviour was exercised on one Windows 11 machine before release: JXL, AVIF, BMP and TIFF files were converted and the returned images were inspected by eye; the missing-decoder error was exercised with a PSD file while ImageMagick was absent; a second call was checked to come from the cache; the source files were hashed before and after conversion to prove they are never written; and a 36-case offline suite was run.
- What was **not** exercised is listed in `README.md` under "Known limits": the HEIC/HEIF decode path and the PSD success path.

What it does not mean:

- It is not a claim that the code is free of defects.
- It is not a substitute for your own review before you install it into a profile that matters to you.

If you find a defect, please open an issue with the exact steps and the observed output.
