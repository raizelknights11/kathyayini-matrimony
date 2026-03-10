package com.kamala;

import com.kamala.controller.HtmlViewGenerator;
import org.apache.poi.ss.usermodel.*;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;

import java.io.InputStream;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

public class ExcelReader {

    // ── Source: Google Sheet (exported as xlsx) ───────────────────────────────
    private static final String EXCEL_URL =
            "https://docs.google.com/spreadsheets/d/1wvVlbvsqj7B21OK0ZjLMTt4Z03LDRWD_dXKFlxhBMKs/export?format=xlsx";

    // ── Template: committed to Git, contains %%DB_DATA%% placeholder ──────────
    private static final String TEMPLATE_FILE = "index.template.html";

    // ── Output: generated at runtime, gitignored, opened in browser ──────────
    private static final String OUTPUT_FILE = "index.html";

    public static void main(String[] args) {
        System.out.println("Reading data from Google Sheets...");
        List<List<String>> data = readExcel(EXCEL_URL);

        if (data == null || data.isEmpty()) {
            System.err.println("Failed to read data. Aborting.");
            return;
        }

        System.out.println("Read " + (data.size() - 1) + " profiles.");
        HtmlViewGenerator.generateApp(data, TEMPLATE_FILE, OUTPUT_FILE);
        HtmlViewGenerator.openBrowser(OUTPUT_FILE);
    }

    private static List<List<String>> readExcel(String fileUrl) {
        List<List<String>> data = new ArrayList<>();
        try (InputStream is = new URL(fileUrl).openStream();
             Workbook wb = new XSSFWorkbook(is)) {

            Sheet sheet = wb.getSheetAt(0);
            DataFormatter df = new DataFormatter();

            for (Row row : sheet) {
                List<String> rowData = new ArrayList<>();
                boolean isEmpty = true;
                for (Cell cell : row) {
                    String val = df.formatCellValue(cell);
                    if (!val.trim().isEmpty()) isEmpty = false;
                    rowData.add(val);
                }
                if (!isEmpty) data.add(rowData);
            }
            return data;

        } catch (Exception e) {
            System.err.println("Error reading spreadsheet: " + e.getMessage());
            e.printStackTrace();
            return null;
        }
    }
}
