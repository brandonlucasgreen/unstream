import XCTest
@testable import Unstream

/// The platform marks are Simple Icons paths parsed by hand in BrandIcons.swift, and Simple Icons
/// packs arc flags with no separator. Read as ordinary numbers, "01" swallowed two flags and every
/// later argument shifted: Buy Me a Coffee and Discogs drew as scribbles of spikes.
final class BrandIconsTests: XCTestCase {

    func testPackedArcFlagsAreTwoTokens() {
        XCTAssertEqual(
            tokenizeSVGPath("a6.3286 6.3286 0 01-3.0069-.756"),
            ["a", "6.3286", "6.3286", "0", "0", "1", "-3.0069", "-.756"]
        )
    }

    func testFlagsCanRunIntoTheNextNumber() {
        // Buy Me a Coffee: flags 0 and 0, then x = 11.343, y = .376, then a second arc.
        XCTAssertEqual(
            tokenizeSVGPath("a39.69 39.69 0 0011.343.376.483.483 0 01.535.53"),
            ["a", "39.69", "39.69", "0", "0", "0", "11.343", ".376", ".483", ".483", "0", "0", "1", ".535", ".53"]
        )
    }

    func testNumbersOutsideFlagPositionsAreUnchanged() {
        XCTAssertEqual(tokenizeSVGPath("M10 01L1.5.5"), ["M", "10", "01", "L", "1.5", ".5"])
        XCTAssertEqual(tokenizeSVGPath("A1 1 0 1 0 10 10"), ["A", "1", "1", "0", "1", "0", "10", "10"])
    }

    func testEveryPlatformLogoHasAPath() {
        for (id, logo) in platformLogos {
            XCTAssertFalse(BrandIconShape(path: logo.path).path(in: CGRect(x: 0, y: 0, width: 24, height: 24)).isEmpty, id)
        }
    }
}
