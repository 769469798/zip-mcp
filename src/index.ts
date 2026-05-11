import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  compressData,
  decompressData,
  getZipInfo,
  DecompressionOptions,
  ZipInfo,
} from "./utils/compression.js";
import * as fs from "fs/promises";
import * as path from "path";

// Create server instance using native MCP SDK
const server = new Server(
  {
    name: "ZIP MCP Server",
    version: "1.0.6",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// General error handling function
const formatError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  } else if (typeof error === "string") {
    return error;
  } else {
    return "Unknown error";
  }
};

// Check if file or directory exists
const exists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

// Get file list (including subdirectories)
const getAllFiles = async (
  dirPath: string,
  fileList: string[] = [],
  basePath: string = dirPath
): Promise<string[]> => {
  const files = await fs.readdir(dirPath);

  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const stat = await fs.stat(filePath);

    if (stat.isDirectory()) {
      fileList = await getAllFiles(filePath, fileList, basePath);
    } else {
      fileList.push(path.relative(basePath, filePath));
    }
  }

  return fileList;
};

// Register tools using ListToolsRequestSchema
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "compress",
        description: "Compress local files or directories into a ZIP file",
        inputSchema: {
          type: "object",
          properties: {
            input: {
              type: "string",
              description: "Path of the file or directory to be compressed",
            },
            output: {
              type: "string",
              description: "Path of the output ZIP file",
            },
            options: {
              type: "object",
              properties: {
                level: {
                  type: "number",
                  minimum: 0,
                  maximum: 9,
                  description: "Compression level (0-9, default is 5)",
                },
                password: {
                  type: "string",
                  description: "Password protection",
                },
                encryptionStrength: {
                  type: "number",
                  enum: [1, 2, 3],
                  description: "Encryption strength (1-3)",
                },
                overwrite: {
                  type: "boolean",
                  description: "Whether to overwrite existing files",
                },
              },
            },
          },
          required: ["input", "output"],
        },
      },
      {
        name: "decompress",
        description: "Decompress local ZIP file to specified directory",
        inputSchema: {
          type: "object",
          properties: {
            input: {
              type: "string",
              description: "Path of the ZIP file",
            },
            output: {
              type: "string",
              description: "Path of the output directory",
            },
            options: {
              type: "object",
              properties: {
                password: {
                  type: "string",
                  description: "Decompression password",
                },
                overwrite: {
                  type: "boolean",
                  description: "Whether to overwrite existing files",
                },
                createDirectories: {
                  type: "boolean",
                  description: "Whether to create non-existent directories",
                },
              },
            },
          },
          required: ["input", "output"],
        },
      },
      {
        name: "getZipInfo",
        description: "Get metadata information of a local ZIP file",
        inputSchema: {
          type: "object",
          properties: {
            input: {
              type: "string",
              description: "Path of the ZIP file",
            },
            options: {
              type: "object",
              properties: {
                password: {
                  type: "string",
                  description: "Decompression password",
                },
              },
            },
          },
          required: ["input"],
        },
      },
      {
        name: "echo",
        description: "Return the input message (for testing)",
        inputSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "Message to be returned",
            },
          },
          required: ["message"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "compress": {
        const input = args.input as string;
        const output = args.output as string;
        const options = args.options as {
          level?: number;
          password?: string;
          encryptionStrength?: 1 | 2 | 3;
          overwrite?: boolean;
        } | undefined;

        const { overwrite, ...compressionOptions } = options || {};
        const shouldOverwrite = overwrite ?? false;

        if ((await exists(output)) && !shouldOverwrite) {
          throw new Error(
            `Output file ${output} already exists. Set overwrite: true to overwrite.`
          );
        }

        const outputDir = path.dirname(output);
        if (!(await exists(outputDir))) {
          await fs.mkdir(outputDir, { recursive: true });
        }

        if (!(await exists(input))) {
          throw new Error(`Input path not found: ${input}`);
        }

        const stats = await fs.stat(input);
        const filesToCompress: { name: string; data: Uint8Array }[] = [];

        if (stats.isDirectory()) {
          const baseDir = path.basename(input);
          const files = await getAllFiles(input);

          for (const relPath of files) {
            const fullPath = path.join(input, relPath);
            const data = await fs.readFile(fullPath);
            filesToCompress.push({
              name: path.join(baseDir, relPath),
              data: new Uint8Array(data),
            });
          }
        } else {
          const data = await fs.readFile(input);
          filesToCompress.push({
            name: path.basename(input),
            data: new Uint8Array(data),
          });
        }

        if (compressionOptions?.level && compressionOptions.level > 9) {
          compressionOptions.level = 9;
        }
        if (compressionOptions?.level && compressionOptions.level < 0) {
          compressionOptions.level = 0;
        }

        const result = await compressData(filesToCompress, compressionOptions);
        await fs.writeFile(output, result);

        return {
          content: [
            {
              type: "text",
              text: `Compression completed. Created ${output} file containing ${filesToCompress.length} files.`,
            },
          ],
        };
      }

      case "decompress": {
        const input = args.input as string;
        const output = args.output as string;
        const options = args.options as {
          password?: string;
          overwrite?: boolean;
          createDirectories?: boolean;
        } | undefined;

        const overwrite = options?.overwrite ?? false;
        const createDirectories = options?.createDirectories ?? true;

        if (!(await exists(input))) {
          throw new Error(`Input file not found: ${input}`);
        }

        if (await exists(output)) {
          const stats = await fs.stat(output);
          if (!stats.isDirectory()) {
            throw new Error(`Output path is not a directory: ${output}`);
          }
        } else {
          if (createDirectories) {
            await fs.mkdir(output, { recursive: true });
          } else {
            throw new Error(`Output directory does not exist: ${output}`);
          }
        }

        const zipData = await fs.readFile(input);
        const result = await decompressData(new Uint8Array(zipData), options || {});

        const extractedFiles: string[] = [];
        for (const file of result) {
          const outputFilePath = path.join(output, file.name);
          const outputFileDir = path.dirname(outputFilePath);

          if (!(await exists(outputFileDir))) {
            await fs.mkdir(outputFileDir, { recursive: true });
          }

          if ((await exists(outputFilePath)) && !overwrite) {
            continue;
          }

          await fs.writeFile(outputFilePath, file.data);
          extractedFiles.push(file.name);
        }

        return {
          content: [
            {
              type: "text",
              text: `Decompression completed. Extracted ${extractedFiles.length} files to ${output}`,
            },
          ],
        };
      }

      case "getZipInfo": {
        const input = args.input as string;
        const options = args.options as { password?: string } | undefined;

        if (!(await exists(input))) {
          throw new Error(`Input file not found: ${input}`);
        }

        const zipData = await fs.readFile(input);
        const metadata = await getZipInfo(new Uint8Array(zipData), options || {});

        const compressionRatio =
          metadata.totalSize > 0
            ? ((1 - metadata.totalCompressedSize / metadata.totalSize) * 100).toFixed(2) + "%"
            : "0%";

        const formatSize = (size: number): string => {
          if (size < 1024) return `${size} B`;
          if (size < 1024 * 1024) return `${(size / 1024).toFixed(2)} KB`;
          if (size < 1024 * 1024 * 1024)
            return `${(size / (1024 * 1024)).toFixed(2)} MB`;
          return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
        };

        const filesInfo = metadata.files
          .map(
            (file: ZipInfo) =>
              `- ${file.filename}: Original size=${formatSize(file.size)}, Compressed=${formatSize(file.compressedSize)}, Encrypted=${file.encrypted ? "Yes" : "No"}`
          )
          .join("\n");

        return {
          content: [
            { type: "text", text: `ZIP file "${path.basename(input)}" information:` },
            { type: "text", text: `Total files: ${metadata.files.length}` },
            { type: "text", text: `Total size: ${formatSize(metadata.totalSize)}` },
            { type: "text", text: `Compressed size: ${formatSize(metadata.totalCompressedSize)}` },
            { type: "text", text: `Compression ratio: ${compressionRatio}` },
            { type: "text", text: `\nFile details:\n${filesInfo}` },
          ],
        };
      }

      case "echo": {
        const message = args.message as string;
        return {
          content: [
            { type: "text", text: message },
            { type: "text", text: new Date().toISOString() },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${formatError(error)}` }],
      isError: true,
    };
  }
});

// Start server with stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ZIP MCP Server started");
}

main().catch(console.error);
