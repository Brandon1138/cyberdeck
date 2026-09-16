import XCTest
@testable import NativeResource

final class NativeResourceTests: XCTestCase {
    func testNormalization() {
        XCTAssertEqual(ResourceFixture.normalize("  ReSoUrCe Managed\n"), "resource managed")
        XCTAssertEqual(ResourceFixture.normalize(" \t\n"), "")
    }
}
