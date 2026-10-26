import XCTest
import Supabase
@testable import Unstream

/// A failed refresh signs the user out only when the server rejected the session.
///
/// Restoring at launch used to clear the session on any error, so a refresh that couldn't reach
/// Supabase (the network not up yet after an update relaunch, or at login) read as a sign-out.
final class AuthSessionRestoreTests: XCTestCase {

    private func apiError(status: Int, code: ErrorCode) -> AuthError {
        let url = URL(string: "https://example.supabase.co/auth/v1/token")!
        return AuthError.api(
            message: "test",
            errorCode: code,
            underlyingData: Data(),
            underlyingResponse: HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!
        )
    }

    func testServerRejectionEndsTheSession() {
        XCTAssertTrue(AuthService.refreshRejectsSession(apiError(status: 400, code: .refreshTokenAlreadyUsed)))
        XCTAssertTrue(AuthService.refreshRejectsSession(apiError(status: 400, code: .refreshTokenNotFound)))
        XCTAssertTrue(AuthService.refreshRejectsSession(apiError(status: 403, code: .sessionExpired)))
        XCTAssertTrue(AuthService.refreshRejectsSession(AuthError.sessionMissing))
    }

    func testUnreachableServerKeepsTheSession() {
        XCTAssertFalse(AuthService.refreshRejectsSession(URLError(.notConnectedToInternet)))
        XCTAssertFalse(AuthService.refreshRejectsSession(URLError(.timedOut)))
        XCTAssertFalse(AuthService.refreshRejectsSession(URLError(.networkConnectionLost)))
        XCTAssertFalse(AuthService.refreshRejectsSession(apiError(status: 503, code: .unexpectedFailure)))
        XCTAssertFalse(AuthService.refreshRejectsSession(apiError(status: 500, code: .unexpectedFailure)))
        XCTAssertFalse(AuthService.refreshRejectsSession(apiError(status: 429, code: .overRequestRateLimit)))
    }
}
