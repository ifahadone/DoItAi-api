/**
 * Unit tests for the Apple StoreKit JWS x5c chain pinning (src/modules/billing/verify.ts).
 *
 * Uses a real, self-contained EC (P-256) certificate chain generated with openssl: a self-signed
 * "Test Root CA" and a "Test Leaf" signed by it. The pin is overridden to the test root's fingerprint
 * so the happy path can be exercised without a live Apple chain; the negative cases prove each guard.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { verifyAppleChain } from '@/modules/billing/verify.js';

// DER (base64) of the generated chain + the test root's SHA-256 fingerprint.
const ROOT_FP =
  'A8:58:A4:61:32:85:88:FE:55:C9:4B:76:AA:53:50:10:1F:5A:94:4B:F9:AD:4B:1F:A3:9E:64:8C:02:F8:CF:9A';
const ROOT_B64 =
  'MIIBqzCCAVGgAwIBAgIURFZP4LmJlXiS50x9OuG9wTbKOZUwCgYIKoZIzj0EAwIwKzEVMBMGA1UEAwwMVGVzdCBSb290IENBMRIwEAYDVQQKDAlEb0lUIFRlc3QwHhcNMjYwNzI3MTAwMjEyWhcNMzYwNzI0MTAwMjEyWjArMRUwEwYDVQQDDAxUZXN0IFJvb3QgQ0ExEjAQBgNVBAoMCURvSVQgVGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABCfXEBURqKMglHMZh6FtY/jjLwWjyaZ/Gyd9aTzq7PxSIfO57ZjVn7Q02I+f1ZbOjj9nbX4/smagILye7cr8MXKjUzBRMB0GA1UdDgQWBBSe9pDwGddR45fxTf7pIm+DAE93kDAfBgNVHSMEGDAWgBSe9pDwGddR45fxTf7pIm+DAE93kDAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIQC/dkedZNjvNKB61RzbvE0BJv47hGoDTIc/N7VIj5VZKAIgWNLRzPWa0KM2hYx/t2ZrBR4Cs+vSEpW5lCVmWjgA674=';
const LEAF_B64 =
  'MIIBgjCCASmgAwIBAgIUCpTqX+0zYJaUItj6LJEKnGS+2NcwCgYIKoZIzj0EAwIwKzEVMBMGA1UEAwwMVGVzdCBSb290IENBMRIwEAYDVQQKDAlEb0lUIFRlc3QwHhcNMjYwNzI3MTAwMjEyWhcNMjcwNzI3MTAwMjEyWjAUMRIwEAYDVQQDDAlUZXN0IExlYWYwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAARIgik4duD20dhCRm8GKc/PjOidpLNgvbS5sgonsBtHxtf0MHmaoWyqskd/cVvir4XEy6qbJJ174CV6YpggGkyKo0IwQDAdBgNVHQ4EFgQU7yUaAOtiGiks7UJIb6XqLv+gazowHwYDVR0jBBgwFoAUnvaQ8BnXUeOX8U3+6SJvgwBPd5AwCgYIKoZIzj0EAwIDRwAwRAIgOZP5FMMeCPkTfrXWw8LOwIgEwR+/8bZdHx4ekgGfUXwCIDGmeXVnJRVprs/mDrehaleC9t97Q8CJCzSamfqNVfzl';

describe('verifyAppleChain', () => {
  afterEach(() => {
    delete process.env.APPLE_ROOT_CA_G3_SHA256;
  });

  it('accepts a well-formed chain that terminates at the pinned root', () => {
    process.env.APPLE_ROOT_CA_G3_SHA256 = ROOT_FP;
    const leaf = verifyAppleChain([LEAF_B64, ROOT_B64]);
    expect(leaf.subject).toContain('Test Leaf');
  });

  it('rejects a valid chain whose root is not the pinned Apple root', () => {
    // No override ⇒ pins Apple Root CA - G3; our test root differs.
    expect(() => verifyAppleChain([LEAF_B64, ROOT_B64])).toThrowError(/pinned Apple Root CA/);
  });

  it('rejects a chain whose links are not signed by their issuer (wrong order)', () => {
    process.env.APPLE_ROOT_CA_G3_SHA256 = ROOT_FP;
    expect(() => verifyAppleChain([ROOT_B64, LEAF_B64])).toThrowError(/not signed by its issuer/);
  });

  it('rejects a chain too short to pin a root', () => {
    expect(() => verifyAppleChain([LEAF_B64])).toThrowError(/too short/);
    expect(() => verifyAppleChain([])).toThrowError(/too short/);
  });

  it('rejects an unparseable certificate', () => {
    expect(() => verifyAppleChain(['not-a-real-cert', 'also-garbage'])).toThrowError(/unparseable/);
  });
});
