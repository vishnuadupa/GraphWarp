import { NextResponse } from 'next/server';
import neo4j from 'neo4j-driver';
import dns from 'dns';

export const dynamic = 'force-dynamic';

export async function GET() {
  const diagnostics: any = {
    env: {
      NEO4J_URI: {
        defined: !!process.env.NEO4J_URI,
        value: process.env.NEO4J_URI ? maskUri(process.env.NEO4J_URI) : null,
      },
      NEO4J_USERNAME: {
        defined: !!process.env.NEO4J_USERNAME,
        value: process.env.NEO4J_USERNAME,
      },
      NEO4J_PASSWORD: {
        defined: !!process.env.NEO4J_PASSWORD,
        length: process.env.NEO4J_PASSWORD?.length ?? 0,
        preview: process.env.NEO4J_PASSWORD ? maskPassword(process.env.NEO4J_PASSWORD) : null,
      },
    },
    dns: null,
    connectionTest: null,
  };

  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USERNAME;
  const password = process.env.NEO4J_PASSWORD;

  if (uri) {
    try {
      const host = extractHost(uri);
      diagnostics.dns = await resolveDns(host);
    } catch (dnsErr: any) {
      diagnostics.dns = { error: dnsErr.message };
    }
  }

  if (uri && user && password) {
    let testDriver: any = null;
    try {
      testDriver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
        connectionAcquisitionTimeout: 5000,
      });
      await testDriver.verifyConnectivity();
      diagnostics.connectionTest = { success: true, message: 'Successfully verified connectivity to Neo4j AuraDB!' };
    } catch (connErr: any) {
      diagnostics.connectionTest = {
        success: false,
        errorName: connErr.name,
        errorMessage: connErr.message,
        gqlStatus: connErr.gqlStatus ?? null,
        gqlStatusDescription: connErr.gqlStatusDescription ?? null,
        code: connErr.code ?? null,
        stack: connErr.stack,
      };
    } finally {
      if (testDriver) {
        await testDriver.close().catch(() => {});
      }
    }
  } else {
    diagnostics.connectionTest = { success: false, error: 'Cannot test connection because one or more env vars are missing.' };
  }

  return NextResponse.json(diagnostics);
}

function maskUri(uri: string): string {
  try {
    const parsed = new URL(uri.replace('neo4j+s://', 'http://').replace('bolt+s://', 'http://'));
    return `${uri.split('://')[0]}://${parsed.host}`;
  } catch {
    return uri.slice(0, 15) + '...';
  }
}

function maskPassword(pass: string): string {
  if (pass.length <= 4) return '***';
  return `${pass.slice(0, 2)}...${pass.slice(-2)} (len: ${pass.length})`;
}

function extractHost(uri: string): string {
  try {
    const clean = uri.replace('neo4j+s://', '').replace('bolt+s://', '').replace('neo4j://', '').replace('bolt://', '');
    return clean.split(':')[0].split('/')[0];
  } catch {
    return uri;
  }
}

function resolveDns(host: string): Promise<any> {
  return new Promise((resolve) => {
    dns.lookup(host, (err, address, family) => {
      if (err) {
        resolve({ host, lookupSuccess: false, errorMessage: err.message });
      } else {
        resolve({ host, lookupSuccess: true, ipAddress: address, family });
      }
    });
  });
}
