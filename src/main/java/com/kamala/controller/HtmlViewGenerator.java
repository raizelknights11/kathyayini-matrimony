package com.kamala.controller;

import java.awt.*;
import java.io.*;
import java.net.URL;
import java.nio.file.*;
import java.util.*;
import java.util.List;
import java.nio.charset.StandardCharsets;

public class HtmlViewGenerator {

    private static final String DB_PLACEHOLDER = "%%DB_DATA%%";

    /**
     * Resolves a filename relative to the project root.
     *
     * When IntelliJ runs ExcelReader, the working directory is typically the
     * project root (where pom.xml lives). But to be safe, we also try the
     * directory that contains the running JAR/classes as a fallback.
     */
    private static Path resolveProjectFile(String fileName) {
        // 1. Try working directory first (standard IntelliJ / mvn exec behaviour)
        Path fromCwd = Paths.get(fileName).toAbsolutePath();
        if (Files.exists(fromCwd)) return fromCwd;

        // 2. Try the directory that contains this compiled class / JAR
        try {
            URL location = HtmlViewGenerator.class.getProtectionDomain()
                    .getCodeSource().getLocation();
            Path classDir = Paths.get(location.toURI()).toAbsolutePath();
            // Walk up from target/classes or target/*.jar until we find pom.xml
            Path dir = Files.isRegularFile(classDir) ? classDir.getParent() : classDir;
            for (int i = 0; i < 5; i++) {
                if (dir == null) break;
                if (Files.exists(dir.resolve("pom.xml"))) {
                    Path candidate = dir.resolve(fileName);
                    if (Files.exists(candidate)) return candidate;
                    // Return anyway so the error message shows the right path
                    return candidate;
                }
                dir = dir.getParent();
            }
        } catch (Exception ignored) {}

        // 3. Give up — return cwd-relative path so the caller shows a clear error
        return fromCwd;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  PUBLIC API
    // ─────────────────────────────────────────────────────────────────────────

    public static void generateApp(List<List<String>> data, String templateFile, String outputFile) {
        if (data == null || data.isEmpty()) {
            System.err.println("No data provided.");
            return;
        }

        // Resolve both paths relative to the project root
        Path templatePath = resolveProjectFile(templateFile);
        Path outputPath   = resolveProjectFile(outputFile);

        System.out.println("Template : " + templatePath);
        System.out.println("Output   : " + outputPath);

        // ── 1. Create images/ folder next to output ───────────────────────────
        Path imageFolder = outputPath.getParent().resolve("images");
        try {
            Files.createDirectories(imageFolder);
        } catch (IOException e) {
            System.err.println("Warning: could not create images/ directory: " + e.getMessage());
        }

        // ── 2. Find photo column indices ──────────────────────────────────────
        List<String> headers = data.get(0);
        List<Integer> photoIndices = new ArrayList<>();
        int uniqueIdIdx = -1;

        for (int i = 0; i < headers.size(); i++) {
            String h = headers.get(i).toLowerCase().trim();
            if (h.equals("unique id"))    uniqueIdIdx = i;
            else if (h.contains("photo")) photoIndices.add(i);
        }

        // ── 3. Download photos (skip if already cached) ───────────────────────
        for (int i = 1; i < data.size(); i++) {
            List<String> row = data.get(i);
            String uniqueId = (uniqueIdIdx != -1 && uniqueIdIdx < row.size())
                    ? row.get(uniqueIdIdx).replaceAll("[^a-zA-Z0-9]", "_")
                    : "row_" + i;

            for (int pIdx : photoIndices) {
                if (pIdx >= row.size()) continue;
                String originalUrl = row.get(pIdx);
                if (originalUrl == null || !originalUrl.contains("drive.google.com")) continue;

                String fileId = extractDriveId(originalUrl);
                if (fileId == null) continue;

                String localFileName = uniqueId + "_" + pIdx + ".jpg";
                Path targetPath = imageFolder.resolve(localFileName);

                if (!Files.exists(targetPath)) {
                    downloadFile("https://drive.google.com/uc?export=download&id=" + fileId, targetPath);
                }

                row.set(pIdx, originalUrl + "|" + "images/" + localFileName);
            }
        }

        // ── 4. Load template ──────────────────────────────────────────────────
        String template;
        try {
            template = new String(Files.readAllBytes(templatePath), StandardCharsets.UTF_8);
        } catch (IOException e) {
            System.err.println("ERROR: Could not read template: " + templatePath);
            System.err.println("Make sure index.template.html exists in the project root.");
            e.printStackTrace();
            return;
        }

        if (!template.contains(DB_PLACEHOLDER)) {
            System.err.println("ERROR: Template does not contain placeholder: " + DB_PLACEHOLDER);
            System.err.println("The line  const db = [...]  must be replaced with: " + DB_PLACEHOLDER);
            return;
        }

        // ── 5. Inject data and write output ───────────────────────────────────
        String finalHtml = template.replace(DB_PLACEHOLDER, "const db = " + convertToJson(data) + ";");
        try {
            Files.write(outputPath, finalHtml.getBytes(StandardCharsets.UTF_8));
            System.out.println("✓ Generated: " + outputPath);
        } catch (IOException e) {
            System.err.println("ERROR: Could not write: " + outputPath);
            e.printStackTrace();
        }
    }

    public static void openBrowser(String file) {
        try {
            Path resolved = resolveProjectFile(file);
            if (Desktop.isDesktopSupported()) {
                Desktop.getDesktop().open(resolved.toFile());
            }
        } catch (Exception e) {
            System.err.println("Could not open browser: " + e.getMessage());
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  PRIVATE HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    private static String extractDriveId(String url) {
        java.util.regex.Matcher m;
        m = java.util.regex.Pattern.compile("[?&]id=([-\\w]{25,})").matcher(url);
        if (m.find()) return m.group(1);
        m = java.util.regex.Pattern.compile("/file/d/([-\\w]{25,})").matcher(url);
        if (m.find()) return m.group(1);
        m = java.util.regex.Pattern.compile("([-\\w]{25,})").matcher(url);
        return m.find() ? m.group(1) : null;
    }

    private static void downloadFile(String urlStr, Path targetPath) {
        try (InputStream in = new URL(urlStr).openStream()) {
            Files.copy(in, targetPath, StandardCopyOption.REPLACE_EXISTING);
            System.out.println("  ↓ " + targetPath.getFileName());
        } catch (Exception e) {
            System.err.println("  ✗ Could not download " + urlStr + " (" + e.getMessage() + ")");
        }
    }

    private static String convertToJson(List<List<String>> data) {
        StringBuilder sb = new StringBuilder("[");
        for (int r = 0; r < data.size(); r++) {
            List<String> row = data.get(r);
            sb.append("[");
            for (int c = 0; c < row.size(); c++) {
                String val = (row.get(c) == null) ? "" : row.get(c);
                val = val
                        .replace("\\", "\\\\")
                        .replace("\"", "\\\"")
                        .replace("\r", "")
                        .replace("\n", " ")
                        .replace("\t", " ");
                sb.append("\"").append(val).append("\"");
                if (c < row.size() - 1) sb.append(",");
            }
            sb.append("]");
            if (r < data.size() - 1) sb.append(",\n");
        }
        return sb.append("]").toString();
    }
}
