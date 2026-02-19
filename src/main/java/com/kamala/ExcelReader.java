package com.kamala;

import com.kamala.controller.HtmlViewGenerator;
import org.apache.poi.ss.usermodel.*;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;

import java.io.InputStream;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;



public class ExcelReader {

    private static final String EXCEL_URL = "https://docs.google.com/spreadsheets/d/1wvVlbvsqj7B21OK0ZjLMTt4Z03LDRWD_dXKFlxhBMKs/export?format=xlsx";
    private static final String HTML_FILE_NAME = "view.html";

    public static void main(String[] args) {
        List<List<String>> data = readExcel(EXCEL_URL);

        if (data != null) {
            HtmlViewGenerator.generateApp(data, HTML_FILE_NAME);
            HtmlViewGenerator.openBrowser(HTML_FILE_NAME);
        }
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
            e.printStackTrace();
            return null;
        }
    }
}
