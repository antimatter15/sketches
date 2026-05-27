(function( root, factory ) {
  const api = factory();

  if( typeof module !== "undefined" && module.exports ) {
    module.exports = api;
  }

  root.KicadZipUtils = api;
})( typeof self !== "undefined" ? self : globalThis, function() {
  const ZIP_EOCD_SIG = 0x06054b50;
  const ZIP_CENTRAL_SIG = 0x02014b50;
  const ZIP_LOCAL_SIG = 0x04034b50;
  const UTF8_FLAG = 0x0800;
  const ENCRYPTED_FLAG = 0x0001;
  const textDecoder = new TextDecoder( "utf-8" );

  function readU16( bytes, offset ) {
    return bytes[offset] | ( bytes[offset + 1] << 8 );
  }

  function readU32( bytes, offset ) {
    return ( readU16( bytes, offset ) | ( readU16( bytes, offset + 2 ) << 16 ) ) >>> 0;
  }

  function toUint8Array( value ) {
    if( value instanceof Uint8Array ) {
      return value;
    }

    return new Uint8Array( value );
  }

  function copyUint8Array( value ) {
    const bytes = toUint8Array( value );
    return bytes.slice();
  }

  function decodePath( bytes, flags ) {
    if( flags & UTF8_FLAG ) {
      return textDecoder.decode( bytes );
    }

    return String.fromCharCode( ...bytes );
  }

  function sanitizeZipPath( rawPath ) {
    return String( rawPath || "" )
      .replaceAll( "\\", "/" )
      .split( "/" )
      .filter( ( part ) => part && part !== "." && part !== ".." )
      .join( "/" );
  }

  function isSkippablePath( path ) {
    return (
      !path ||
      path.endsWith( "/" ) ||
      path.startsWith( "__MACOSX/" ) ||
      path.endsWith( "/.DS_Store" ) ||
      path === ".DS_Store"
    );
  }

  function isZipPath( path ) {
    return /\.zip$/i.test( String( path || "" ) );
  }

  async function inflateRaw( bytes, sourceLabel ) {
    const input = toUint8Array( bytes );

    if( typeof process !== "undefined" && process.versions && process.versions.node ) {
      const zlib = require( "zlib" );
      const out = zlib.inflateRawSync( Buffer.from( input ) );
      return new Uint8Array( out.buffer, out.byteOffset, out.byteLength ).slice();
    }

    if( typeof DecompressionStream !== "undefined" ) {
      const stream = new Blob( [ input ] ).stream().pipeThrough( new DecompressionStream( "deflate-raw" ) );
      return new Uint8Array( await new Response( stream ).arrayBuffer() );
    }

    throw new Error( `ZIP archive uses deflate compression, but no inflater is available for ${sourceLabel}.` );
  }

  function findEndOfCentralDirectory( bytes, sourceLabel ) {
    const start = Math.max( 0, bytes.length - 0x10000 - 22 );

    for( let offset = bytes.length - 22; offset >= start; offset -= 1 ) {
      if( readU32( bytes, offset ) === ZIP_EOCD_SIG ) {
        return offset;
      }
    }

    throw new Error( `Could not read ZIP archive structure for ${sourceLabel}.` );
  }

  async function readZipEntries( inputBytes, sourceLabel = "archive.zip" ) {
    const bytes = toUint8Array( inputBytes );
    const eocdOffset = findEndOfCentralDirectory( bytes, sourceLabel );
    const entryCount = readU16( bytes, eocdOffset + 10 );
    const centralDirOffset = readU32( bytes, eocdOffset + 16 );
    const entries = [];
    let centralOffset = centralDirOffset;

    for( let index = 0; index < entryCount; index += 1 ) {
      if( readU32( bytes, centralOffset ) !== ZIP_CENTRAL_SIG ) {
        throw new Error( `Invalid ZIP central directory entry in ${sourceLabel}.` );
      }

      const flags = readU16( bytes, centralOffset + 8 );
      const method = readU16( bytes, centralOffset + 10 );
      const compressedSize = readU32( bytes, centralOffset + 20 );
      const uncompressedSize = readU32( bytes, centralOffset + 24 );
      const nameLength = readU16( bytes, centralOffset + 28 );
      const extraLength = readU16( bytes, centralOffset + 30 );
      const commentLength = readU16( bytes, centralOffset + 32 );
      const localOffset = readU32( bytes, centralOffset + 42 );
      const nameBytes = bytes.subarray( centralOffset + 46, centralOffset + 46 + nameLength );
      const rawPath = decodePath( nameBytes, flags );
      const path = sanitizeZipPath( rawPath );

      centralOffset += 46 + nameLength + extraLength + commentLength;

      if( isSkippablePath( path ) ) {
        continue;
      }

      if( flags & ENCRYPTED_FLAG ) {
        throw new Error( `Encrypted ZIP entries are not supported: ${rawPath}` );
      }

      if( readU32( bytes, localOffset ) !== ZIP_LOCAL_SIG ) {
        throw new Error( `Invalid ZIP local file header in ${sourceLabel} for ${rawPath}.` );
      }

      const localNameLength = readU16( bytes, localOffset + 26 );
      const localExtraLength = readU16( bytes, localOffset + 28 );
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.subarray( dataOffset, dataOffset + compressedSize );
      let data;

      if( method === 0 ) {
        data = copyUint8Array( compressed );
      } else if( method === 8 ) {
        data = await inflateRaw( compressed, sourceLabel );
      } else {
        throw new Error( `Unsupported ZIP compression method ${method} for ${rawPath}.` );
      }

      if( uncompressedSize && data.length !== uncompressedSize ) {
        throw new Error( `ZIP entry size mismatch for ${rawPath}.` );
      }

      entries.push( { path, bytes: data } );
    }

    return entries;
  }

  async function expandEntries( entries ) {
    const expanded = [];

    for( const entry of entries ) {
      if( isZipPath( entry.path ) ) {
        const zipEntries = await readZipEntries( entry.bytes, entry.path );

        if( !zipEntries.length ) {
          throw new Error( `ZIP archive did not contain any usable files: ${entry.path}` );
        }

        expanded.push( ...zipEntries );
      } else {
        expanded.push( {
          path: sanitizeZipPath( entry.path ),
          bytes: copyUint8Array( entry.bytes )
        } );
      }
    }

    return expanded;
  }

  return {
    expandEntries,
    isZipPath,
    readZipEntries,
    sanitizeZipPath
  };
} );
