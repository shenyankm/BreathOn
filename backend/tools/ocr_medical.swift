// Optional macOS Vision OCR for public scanned originals; output always needs medical review.
import Foundation
import Vision
import PDFKit
import AppKit

let path = CommandLine.arguments[1]
var output: [[String: Any]] = []
func recognize(_ image: CGImage) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: image).perform([request])
    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}
func tiles(_ image: CGImage) throws -> String {
    var parts: [String] = []
    for y in stride(from: 0, to: image.height, by: 3000) {
        let height = min(3100, image.height - y)
        if let tile = image.cropping(to: CGRect(x: 0, y: y, width: image.width, height: height)) {
            parts.append(try recognize(tile))
        }
    }
    return parts.joined(separator: "\n")
}
if path.lowercased().hasSuffix(".pdf"), let document = PDFDocument(url: URL(fileURLWithPath: path)) {
    guard document.pageCount <= 100 else { fatalError("OCR page limit") }
    for index in 0..<document.pageCount {
        try autoreleasepool {
            guard let page = document.page(at: index) else { return }
            let bounds = page.bounds(for: .mediaBox)
            let scale = min(3, 2500 / max(bounds.width, 1))
            let width = Int(bounds.width * scale), height = Int(bounds.height * scale)
            guard width > 0 && height > 0 && width * height < 90_000_000 else { fatalError("OCR image limit") }
            let space = CGColorSpaceCreateDeviceRGB()
            guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fatalError("Cannot render PDF") }
            context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            context.scaleBy(x: scale, y: scale); page.draw(with: .mediaBox, to: context)
            if let image = context.makeImage() { output.append(["number": index + 1, "text": try tiles(image)]) }
        }
    }
} else {
    guard let image = NSImage(contentsOfFile: path)?.cgImage(forProposedRect: nil, context: nil, hints: nil) else { fatalError("Cannot read image") }
    output.append(["number": 1, "text": try tiles(image)])
}
let encoded = try JSONSerialization.data(withJSONObject: output)
FileHandle.standardOutput.write(encoded)
