/**
 * RETS response format
 */
export enum RetsFormat {
    /**
     * Compact data (usually TSV)
     */
    Compact = 'COMPACT',
    /**
     * Compact decoded data (usually TSV)
     */
    CompactDecoded = 'COMPACT-DECODED',
    /**
     * Standard XML data (server may not support)
     */
    StandardXml = 'STANDARD-XML'
}
