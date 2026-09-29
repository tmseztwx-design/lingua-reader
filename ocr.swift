import AppKit
import Foundation
import ImageIO
import PDFKit
import Vision

struct SourceFile: Decodable {
  let id: String
  let name: String
  let path: String
  let type: String
}

func emit(_ value: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
        let line = String(data: data, encoding: .utf8) else { return }
  FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

func recognize(_ image: CGImage) throws -> (String, Double) {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  request.recognitionLanguages = ["en-US", "zh-Hans", "zh-Hant"]
  try VNImageRequestHandler(cgImage: image).perform([request])
  let lines = (request.results ?? []).sorted {
    let yDelta = $0.boundingBox.midY - $1.boundingBox.midY
    return abs(yDelta) > 0.012 ? yDelta > 0 : $0.boundingBox.minX < $1.boundingBox.minX
  }
  let text = lines.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
  let confidence = lines.isEmpty ? 0 : lines.compactMap { $0.topCandidates(1).first?.confidence }.reduce(0, +) / Float(lines.count)
  return (text, Double(confidence))
}

func textUtil(_ path: String) throws -> String {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/textutil")
  process.arguments = ["-convert", "txt", "-stdout", path]
  let output = Pipe()
  let errors = Pipe()
  process.standardOutput = output
  process.standardError = errors
  try process.run()
  let data = output.fileHandleForReading.readDataToEndOfFile()
  process.waitUntilExit()
  guard process.terminationStatus == 0, let value = String(data: data, encoding: .utf8) else {
    let message = String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "无法读取 Word 文档。"
    throw NSError(domain: "ScribeOCR", code: Int(process.terminationStatus), userInfo: [NSLocalizedDescriptionKey: message])
  }
  return value.trimmingCharacters(in: .whitespacesAndNewlines)
}

func emitPage(_ file: SourceFile, _ pageIndex: Int, _ text: String, _ confidence: Double, _ error: String? = nil) {
  var result: [String: Any] = ["kind": "page", "fileId": file.id, "name": file.name, "pageIndex": pageIndex, "text": text, "confidence": confidence]
  if let error { result["error"] = error }
  emit(result)
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let files = try? JSONDecoder().decode([SourceFile].self, from: input) else {
  emit(["kind": "fatal", "error": "无法读取处理清单。"])
  exit(2)
}

var pageCount = 0
for file in files {
  let url = URL(fileURLWithPath: file.path)
  let ext = url.pathExtension.lowercased()
  do {
    if ext == "pdf" {
      guard let pdf = PDFDocument(url: url) else { throw NSError(domain: "ScribeOCR", code: 1, userInfo: [NSLocalizedDescriptionKey: "无法打开 PDF。"] ) }
      for index in 0..<pdf.pageCount {
        guard let page = pdf.page(at: index) else { emitPage(file, index, "", 0, "无法读取 PDF 第 \(index + 1) 页。"); pageCount += 1; continue }
        var text = (page.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        var confidence = text.isEmpty ? 0.0 : 1.0
        if text.isEmpty {
          let thumbnail = page.thumbnail(of: CGSize(width: 1800, height: 2400), for: .mediaBox)
          if let image = thumbnail.cgImage(forProposedRect: nil, context: nil, hints: nil) {
            (text, confidence) = try recognize(image)
          }
        }
        emitPage(file, index, text, confidence, text.isEmpty ? "本页没有识别到可读文字。" : nil)
        pageCount += 1
      }
    } else if ["doc", "docx", "rtf"].contains(ext) {
      let text = try textUtil(file.path)
      emitPage(file, 0, text, text.isEmpty ? 0 : 1, text.isEmpty ? "文档中没有提取到文字。" : nil)
      pageCount += 1
    } else if ["txt", "text", "md"].contains(ext) {
      let data = try Data(contentsOf: url)
      let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .utf16) ?? ""
      emitPage(file, 0, text, text.isEmpty ? 0 : 1, text.isEmpty ? "文本文件编码无法识别或内容为空。" : nil)
      pageCount += 1
    } else if let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) {
      let (text, confidence) = try recognize(image)
      emitPage(file, 0, text, confidence, text.isEmpty ? "图片中没有识别到可读文字。" : nil)
      pageCount += 1
    } else {
      throw NSError(domain: "ScribeOCR", code: 2, userInfo: [NSLocalizedDescriptionKey: "此文件格式暂不支持文字提取。"])
    }
  } catch {
    emitPage(file, 0, "", 0, error.localizedDescription)
    pageCount += 1
  }
}
emit(["kind": "done", "count": pageCount])
