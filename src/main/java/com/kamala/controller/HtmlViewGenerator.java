package com.kamala.controller;

import java.awt.*;
import java.io.*;
import java.net.URL;
import java.nio.file.*;
import java.util.*;
import java.util.List;
import java.nio.charset.StandardCharsets;

public class HtmlViewGenerator {

    private static final List<String> EXCLUDED_KEYWORDS = Arrays.asList("Timestamp", "I Herby",
            "Filling the Form For","Unique ID", "Email Address", "Address", "Phone Number", "Salary");

    public static void generateApp(List<List<String>> data, String fileName) {
        if (data == null || data.isEmpty()) return;

        // Create a local images directory
        String outputDir = new File(fileName).getParent();
        if (outputDir == null) outputDir = ".";
        Path imageFolder = Paths.get(outputDir, "images");

        try {
            Files.createDirectories(imageFolder);
        } catch (IOException e) { e.printStackTrace(); }

        List<String> headers = data.get(0);
        List<Integer> photoIndices = new ArrayList<>();
        List<Integer> excludedIndices = new ArrayList<>();
        int horoscopeIdx = -1;
        int typeIdx = -1;
        int uniqueIdIdx = -1;

        for (int i = 0; i < headers.size(); i++) {
            if (headers.get(i).equalsIgnoreCase("Unique ID")) {
                uniqueIdIdx = i;
                break;
            }
        }

        for (int i = 0; i < headers.size(); i++) {
            String headLower = headers.get(i).toLowerCase().trim();

            boolean isExcluded = EXCLUDED_KEYWORDS.stream()
                    .anyMatch(k -> headLower.contains(k.toLowerCase().trim()));

            if (isExcluded) {
                excludedIndices.add(i);
            }

            if (headLower.contains("filling the form for")) {
                typeIdx = i;
            } else if (headLower.contains("photo")) {
                photoIndices.add(i);
            } else if (headLower.contains("horoscope")) {
                horoscopeIdx = i;
            }
        }

        // Process rows and Download Images
        for (int i = 1; i < data.size(); i++) {
            List<String> row = data.get(i);
            String uniqueId = (uniqueIdIdx != -1) ? row.get(uniqueIdIdx).replaceAll("[^a-zA-Z0-9]", "_") : "row_" + i;

            for (int pIdx : photoIndices) {
                String originalUrl = row.get(pIdx);
                if (originalUrl != null && originalUrl.contains("drive.google.com")) {
                    String fileId = extractId(originalUrl);
                    String localFileName = uniqueId + "_" + pIdx + ".jpg";
                    Path targetPath = imageFolder.resolve(localFileName);

                    // SYNC: Only download if missing
                    if (!Files.exists(targetPath)) {
                        String downloadUrl = "https://drive.google.com/uc?export=download&id=" + fileId;
                        downloadFile(downloadUrl, targetPath);
                    }

                    String combinedPath = originalUrl + "|" + "images/" + localFileName;
                    row.set(pIdx, combinedPath);
                }
            }
        }

        try {
            String template = new String(Files.readAllBytes(Paths.get("DetailsViewPage.html")));
            String finalHtml = template
                    .replace("{{DATA_JSON}}", convertToJson(data))
                    .replace("{{PHOTO_INDICES}}", photoIndices.toString())
                    .replace("{{EXCLUDED_INDICES}}", excludedIndices.toString())
                    .replace("{{HOROSCOPE_INDEX}}", String.valueOf(horoscopeIdx))
                    .replace("{{TYPE_INDEX}}", String.valueOf(typeIdx));

            Files.write(Paths.get(fileName), finalHtml.getBytes(StandardCharsets.UTF_8));
            System.out.println("App generated successfully with local images!");

        } catch (IOException e) {
            System.err.println("Note: Could not copy style.css automatically.");
            e.printStackTrace();
        }

        try {
            File htmlFile = new File(fileName);
            String parentDir = htmlFile.getParent();
            if (parentDir == null) parentDir = ".";

            Path sourceCss = Paths.get("DetailsPageStyle.css");
            Path targetCss = Paths.get(parentDir, "DetailsPageStyle.css");

            if (Files.exists(sourceCss)) {
                Files.copy(sourceCss, targetCss, StandardCopyOption.REPLACE_EXISTING);
                System.out.println("Successfully copied DetailsPageStyle.css to " + parentDir);
            } else {
                System.out.println("Warning: DetailsPageStyle.css not found in project root. Skipping copy.");
            }
        } catch (IOException e) {
            System.err.println("Error copying DetailsPageStyle.css: " + e.getMessage());
        }
    }

    private static String extractId(String url) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("([-\\w]{25,})").matcher(url);
        return m.find() ? m.group(1) : null;
    }

    private static void downloadFile(String urlStr, Path targetPath) {
        try (InputStream in = new URL(urlStr).openStream()) {
            Files.copy(in, targetPath, StandardCopyOption.REPLACE_EXISTING);
        } catch (Exception e) {
            System.err.println("Failed to download: " + urlStr);
        }
    }

    private static String convertToJson(List<List<String>> data) {
        StringBuilder sb = new StringBuilder("[");
        for (List<String> row : data) {
            sb.append("[");
            for (String s : row) {
                String val = (s == null) ? "" : s;
                String escaped = val.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ");
                sb.append("\"").append(escaped).append("\",");
            }
            sb.append("],");
        }
        return sb.append("]").toString();
    }

    public static void openBrowser(String file) {
        try {
            File htmlFile = new File(file);
            if (Desktop.isDesktopSupported()) {
                Desktop.getDesktop().open(htmlFile);
            }
        } catch (Exception e) { e.printStackTrace(); }
    }
}