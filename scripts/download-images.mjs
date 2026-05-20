#!/usr/bin/env node
/**
 * Downloads property images from Google Drive, converts HEIC -> JPEG via sharp,
 * and writes them to public/images/<slug>/NN.jpg (or .png).
 *
 * Drive direct download URL format:
 *   https://drive.google.com/uc?export=download&id=FILE_ID
 *
 * For large files Drive shows a confirm page; for typical photo sizes (<25 MB)
 * the download is direct. If you hit the confirm page in the future, fetch
 * googleusercontent.com/uc?id=... with the confirm token instead.
 */

import { mkdir, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = path.resolve(__dirname, "..", "public", "images");

/** @type {Record<string, { format: "heic" | "png" | "jpg"; ids: string[] }>} */
const PROPERTIES = {
  "villa-b11": {
    format: "heic",
    ids: [
      "14B2U2sGr4r3UjzRBOVIRFI14lduljlTO",
      "1qQ4z82h_n-5P9kL6MlN7M9HafpYav_Mv",
      "1S123O5G3mAfrkuTQiObs4nyzZKp8Yh_F",
      "1HQTZfj1myLzJIcUK7EOcTFUA4tA9Vtk0",
      "1n4ysGfAc_y53wAL8iuvv7yYGkg37Pusk",
      "1N5bK8MvLDXSGIl2xNYaMdW9tDPrPhgsM",
      "15Su8614flsnL25E0CtgX4LbogWnF2j6m",
      "1yUZrg_yUcnRuI-hlWnFedQGOvUxMJ-of",
      "1m84FoR2WeXQXm5yLOzqaiDLMS_hoFPvX",
      "1hWuhaxrxvpVYYNGWsVSuAiDsi0CJ5DHD",
      "1m2NA0vQgJuAPK-ZYM0rFPNUbo_JQ8tv1",
      "10-S0nsh5HgKdfDz7HZSudJFWI82sVVDA",
      "15wXMwK-Vzym-K7rgm1rVnC0b9O1Bx8bo",
      "1LrbykkwplwGiPx6Hg1Bp7BRpRqWNP-_v",
      "12suiSqsS35f-VuMU4TQIDMCjr2QmuUhN",
    ],
  },
  "casa-brisa": {
    format: "png",
    ids: [
      "1-7dzkdI_FjQrxAsLucdAmFSdqHxMStje",
      "1cWqp59LIkIh_laMj_kXmHhlgv6gPEqhS",
      "1jkMxXaLOSpFtWsGt7jUKA8xoP8Ckvbei",
      "1_vn_2eAP2jo6swyVMdXTxx53hcCKLy2b",
      "12cGz_kJ5NmY2kf_DG48CDZesdtsD8w50",
      "102GZ6hcozlIEtj5HiHfgLMwMCn5T1lzZ",
      "1j4fwR201yY_lpRUZlX54Llq_7m5pOlhN",
      "1AeXFNUT2uryDvJPEqbbZltOgkwLJFkp1",
      "1nkvEJFMxjbaGhJKla7QA8HnZEqwGctTC",
      "1eb-xo-Lz-jlH9uOXs2RVvH2YeJgkthiQ",
      "18Nw1OdQAZAkdb8meQ5G76ZSjZCInCGrt",
      "1fHCXyY-SbpK7FKvl9wOhMonJgOyQ3erh",
    ],
  },
  "casa-marea": {
    format: "jpg",
    ids: [
      "1fQLVemQ_by31cIi8GX7VnYn8DrP1Lcsh",
      "1kytSZ_oziNn2_QdhLn1v9AAe7cHoIvw5",
      "1cpjq39sRDGRFLcX4MXo7IbQdFelYcr4x",
      "1F9__U_eqrMqSq0IWBa-Ym9rfZdUOaAzQ",
      "109BCITcZYjVOnGwZyNiWtAXuXpGUMHui",
      "1RdVKLjUX3d44CwS94ORLwG701k0X-U2p",
      "1yoadcjerkyXWLkgqY-fVwR82fWp_Fkwh",
      "1JoSsawXdtf5y7cUnW4bGcMyPNoY1lItX",
      "1GIoZdzrH8NkNq0zlElwRyiW267Mfq_8C",
      "18pcTX9HO-b6ZMfwMZfKQWTqqUcW-tdpG",
      "10nhXhDMz6xcuN5MGpYhPmaKjwDcPsb8Q",
      "1UWTCJZLgv9HmzFk8pokZAiSV5TEbLVJG",
      "1B9uGMzyxIyz7hwYfVg_XxTFsooNueq3W",
      "1GtK0faeHa89SCKpmydbhBy0aiCVejpb_",
      "1tix1VtDSnoMellrKwQehY6a_Q18W6fuI",
      "1DsA11H0G8x5XIpqeVCIkElAdGjPsVkae",
    ],
  },
  "centro-morazan": {
    format: "heic",
    ids: [
      "1alfe6KA4EwFmdFcGb800hgW8lHZnTLcz",
      "1f_ysBM4LgKggp7TOp1yIZErQfUgX2_p3",
      "1fAoUecsc6uAHDzfoN2Z9ctIgKlUInzih",
      "189V7ODO1tJJP7OmXIg_MW4hleuFaPnGs",
      "1aR8AAmrz9JYqKdCBNcfz792QFT_GadpK",
      "1AKpvv9QpTsimirZzLAv7KdnkmBhO7vwK",
      "1SWgZi7kJr5n_DP1GWzutKBUMj_r_0qxE",
      "1a1HLKh4tA_y0_cS0dTNwLdAceumshn9Z",
      "1CQgZ18NRUVM4MEPi3xJpRoOCWxTJBDkt",
      "1ZUSz8Y2IEL7XN9stEuDKPXsnno_KprBt",
      "1hCtGvaMTjQRsBOE3tYdaMvT_b9nwYvCV",
    ],
  },
  "casa-lara-townhouse": {
    format: "heic",
    ids: [
      "1Sn6CLtpln7QOecAu-BzvAu1vjMyz_yST",
      "1Ui3rEuoo9XwR5Nft1npoESvx7p1El7wZ",
      "1mHWZ1TRxVsrrvae6ehlEIcxsBM_mrn7n",
      "1ntSq51XrTqym51wO0pCuZhZiDNJrBwek",
      "1_8FB7z_cCtdklD_Vh71Wq4UjYEJl6BHp",
      "1Z-l5j0AUvmloSLoa9YKtBIYVpHLZHaw8",
      "1lOpIlEn093Dwj_QyluWZ8KB-gGh1hj4w",
      "18NzXqbNU-QPQqZPFuAG_FMLwl7ULt0ao",
      "1BdkseOMrBY-_7WbRbS8V5EM4pxp9d3dD",
      "1ugstFzKU0RS5NRQVo-k6CoiZJS1ijQbS",
      "1KqfuUhvJxWBC2jKiaReEubSLps_fknvy",
      "1LJfnCnaYmT6L4i1RhO1w8OPyfb6cgT7Q",
      "1mlRp79A-3JrrJWbG1ceOMV6lPWD1o09u",
      "1QS6bsc6l2e2Oqte_0MyRW1G6lVeEpp2X",
      "1ZUsi9U92q4d1pi33itc9EX4rVO6FSO7B",
    ],
  },
  "la-florida": {
    format: "heic",
    ids: [
      "1xxDGbDbF78Qqf7R1qmn4R6PIZQu6i0TL",
      "13o6f6lGmeMV3knQfb5OKk4bZSjStVEYh",
      "146bnmYQA8epJXaZMBb6y6TsIMJeAI9CA",
      "13aB4lF7hAi5p2Ii2Z0dvLBCj67FTSdYn",
      "10zpkEQADGnn45lQ7O1geKBg_WT3geMfx",
      "1wICGqqcn4btrVi-oKWmje4QpTk4o5O9z",
    ],
  },
};

const FORCE = process.argv.includes("--force");

function pad(n) {
  return String(n).padStart(2, "0");
}

async function downloadBuffer(fileId) {
  const url = `https://drive.google.com/uc?export=download&id=${fileId}`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${fileId}`);
  }
  const ct = res.headers.get("content-type") || "";
  // If Drive returned HTML, it's the virus-scan warning page.
  if (ct.includes("text/html")) {
    const html = await res.text();
    const m = html.match(/confirm=([0-9A-Za-z_-]+)/);
    if (!m) {
      throw new Error(
        `Drive returned HTML for ${fileId} (no confirm token found)`
      );
    }
    const confirmUrl = `https://drive.google.com/uc?export=download&confirm=${m[1]}&id=${fileId}`;
    const res2 = await fetch(confirmUrl, { redirect: "follow" });
    if (!res2.ok) throw new Error(`HTTP ${res2.status} on confirm`);
    return Buffer.from(await res2.arrayBuffer());
  }
  return Buffer.from(await res.arrayBuffer());
}

// macOS `sips` decodes HEIC reliably without extra system libraries.
// We write the HEIC to a temp file, convert in place, then read the JPEG back.
async function heicToJpeg(buf) {
  const tmpIn = path.join(tmpdir(), `jacari-${randomUUID()}.heic`);
  const tmpOut = path.join(tmpdir(), `jacari-${randomUUID()}.jpg`);
  try {
    await writeFile(tmpIn, buf);
    await new Promise((resolve, reject) => {
      const p = spawn("sips", [
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        "85",
        tmpIn,
        "--out",
        tmpOut,
      ]);
      let stderr = "";
      p.stderr.on("data", (d) => (stderr += d.toString()));
      p.on("error", reject);
      p.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`sips exit ${code}: ${stderr}`))
      );
    });
    // Re-process with sharp to normalize orientation EXIF.
    return await sharp(tmpOut).rotate().jpeg({ quality: 85 }).toBuffer();
  } finally {
    await unlink(tmpIn).catch(() => {});
    await unlink(tmpOut).catch(() => {});
  }
}

async function processProperty(slug, { format, ids }) {
  const dir = path.join(OUT_ROOT, slug);
  await mkdir(dir, { recursive: true });

  console.log(`\n[${slug}] ${ids.length} images`);

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const idx = pad(i + 1);
    // Always end up as .jpg or .png; HEIC is converted to JPEG.
    const outExt = format === "png" ? "png" : "jpg";
    const outPath = path.join(dir, `${idx}.${outExt}`);

    if (existsSync(outPath) && !FORCE) {
      console.log(`  ${idx}  skip (exists)`);
      continue;
    }

    try {
      const buf = await downloadBuffer(id);
      if (format === "heic") {
        // sharp's bundled libvips on macOS doesn't decode HEIC; use `sips`.
        const jpeg = await heicToJpeg(buf);
        await writeFile(outPath, jpeg);
      } else {
        // PNG / JPG: write as-is. Optionally re-encode JPG through sharp
        // to normalize orientation metadata.
        if (format === "jpg") {
          const norm = await sharp(buf).jpeg({ quality: 88 }).toBuffer();
          await writeFile(outPath, norm);
        } else {
          await writeFile(outPath, buf);
        }
      }
      console.log(`  ${idx}  ok   (${(buf.length / 1024).toFixed(0)} KB)`);
    } catch (err) {
      console.error(`  ${idx}  FAIL ${id}: ${err.message}`);
    }
  }
}

async function main() {
  await mkdir(OUT_ROOT, { recursive: true });
  for (const [slug, cfg] of Object.entries(PROPERTIES)) {
    await processProperty(slug, cfg);
  }
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
