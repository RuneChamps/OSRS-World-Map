import { vec2, vec4 } from "gl-matrix";
import PicoGL, {
    DrawCall,
    Framebuffer,
    App as PicoApp,
    Program,
    Renderbuffer,
    Texture,
    UniformBuffer,
    VertexArray,
    VertexBuffer,
} from "picogl";

import { newDrawRange } from "../../mapviewer/webgl/DrawRange";
import { createTextureArray } from "../../picogl/PicoTexture";
import { getMapSquareId } from "../../rs/map/MapFileIndex";
import { Scene } from "../../rs/scene/Scene";
import { clamp } from "../../util/MathUtil";
import { MapEditorRenderer } from "../MapEditorRenderer";
import { EditorMapSquare } from "./EditorMapSquare";
import {
    GRID_PROGRAM,
    HIGHLIGHT_PROGRAM,
    TERRAIN_PROGRAM,
    TILE_PICKING_PROGRAM,
} from "./shaders/Shaders";

const MAX_TEXTURES = 256;
const TEXTURE_SIZE = 128;

export class WebGLMapEditorRenderer extends MapEditorRenderer<EditorMapSquare> {
    app!: PicoApp;
    gl!: WebGL2RenderingContext;

    hasMultiDraw: boolean = false;

    // Shaders
    shadersPromise?: Promise<Program[]>;
    terrainProgram?: Program;
    tilePickingProgram?: Program;
    highlightTileProgram?: Program;
    gridProgram?: Program;

    // Uniforms
    sceneUniformBuffer?: UniformBuffer;

    cameraPosUni: vec2 = vec2.fromValues(0, 0);
    resolutionUni: vec2 = vec2.fromValues(0, 0);

    // Framebuffers
    pickFramebuffer?: Framebuffer;
    pickColorTarget?: Renderbuffer;
    pickDepthTarget?: Renderbuffer;

    // Textures
    textureArray?: Texture;
    textureMaterials?: Texture;

    textureIds: number[] = [];
    loadedTextureIds: Set<number> = new Set();

    // Geometry
    gridVertexBuffer?: VertexBuffer;
    gridVertexArray?: VertexArray;

    chunkGridVertexBuffer?: VertexBuffer;
    chunkGridVertexArray?: VertexArray;

    // Draw calls
    tilePickingDrawCall!: DrawCall;
    highlightTileDrawCall!: DrawCall;

    gridDrawCall!: DrawCall;
    chunkGridDrawCall!: DrawCall;

    // State
    tilePickingBuffer = new Uint8Array(4);

    brushSize: number = 0;

    hoverWorldX: number = -1;
    hoverWorldY: number = -1;

    lastTimeTerrainUpdated: number = 0;
    updatedTerrainMapIds: Set<number> = new Set();
    loadingTerrainMapIds: Set<number> = new Set();

    drawGrid: boolean = false;
    drawChunkGrid: boolean = false;

    mapSquareGridColor: vec4 = vec4.fromValues(1.0, 0.0, 0.0, 1.0);
    mapChunkGridColor: vec4 = vec4.fromValues(0.0, 1.0, 0.0, 1.0);

    async init(): Promise<void> {
        await super.init();

        this.app = PicoGL.createApp(this.canvas);
        this.gl = this.app.gl as WebGL2RenderingContext;

        // hack to get the right multi draw extension for picogl
        const state: any = this.app.state;
        const ext = this.gl.getExtension("WEBGL_multi_draw");
        PicoGL.WEBGL_INFO.MULTI_DRAW_INSTANCED = ext;
        state.extensions.multiDrawInstanced = ext;

        this.hasMultiDraw = !!PicoGL.WEBGL_INFO.MULTI_DRAW_INSTANCED;

        this.app.enable(PicoGL.CULL_FACE);
        this.app.enable(PicoGL.DEPTH_TEST);
        this.app.depthFunc(PicoGL.LEQUAL);
        this.app.enable(PicoGL.BLEND);
        this.app.blendFunc(PicoGL.SRC_ALPHA, PicoGL.ONE_MINUS_SRC_ALPHA);
        this.app.clearColor(0.0, 0.0, 0.0, 1.0);
        this.app.clear();

        this.shadersPromise = this.initShaders();
        await this.shadersPromise;

        this.sceneUniformBuffer = this.app.createUniformBuffer([
            PicoGL.FLOAT_MAT4, // mat4 u_viewProjMatrix;
            PicoGL.FLOAT_MAT4, // mat4 u_viewMatrix;
            PicoGL.FLOAT_MAT4, // mat4 u_projectionMatrix;
        ]);

        this.initFramebuffers();
        this.initTextures();
        this.initGrid();

        this.tilePickingDrawCall.uniformBlock("SceneUniforms", this.sceneUniformBuffer);
        // 6 vertices/2 triangles per tile
        this.tilePickingDrawCall.drawRanges(newDrawRange(0, 64 * 64 * 6));

        this.highlightTileDrawCall.uniformBlock("SceneUniforms", this.sceneUniformBuffer);
        // 6 vertices/2 triangles per tile
        this.highlightTileDrawCall.drawRanges(newDrawRange(0, 6));
    }

    async initShaders(): Promise<Program[]> {
        const hasMultiDraw = this.hasMultiDraw;

        const programs = await this.app.createPrograms(
            TERRAIN_PROGRAM,
            TILE_PICKING_PROGRAM,
            HIGHLIGHT_PROGRAM,
            GRID_PROGRAM,
        );

        const [terrainProgram, tilePickingProgram, highlightTileProgram, gridProgram] = programs;
        this.terrainProgram = terrainProgram;
        this.tilePickingProgram = tilePickingProgram;
        this.highlightTileProgram = highlightTileProgram;
        this.gridProgram = gridProgram;

        this.tilePickingDrawCall = this.app.createDrawCall(this.tilePickingProgram);
        this.highlightTileDrawCall = this.app.createDrawCall(this.highlightTileProgram);

        return programs;
    }

    createGridPoints(chunkGrid: boolean): Uint16Array {
        const lineCount = chunkGrid ? 9 : 2;

        const points = new Uint16Array(64 * lineCount * 2 * 2 * 2);
        let offset = 0;
        // Horizontal lines
        for (let y = 0; y < 9; y++) {
            for (let x = 0; x < 64; x++) {
                if (y !== 0 && y !== 8 && !chunkGrid) {
                    continue;
                }
                points[offset++] = x * 128;
                points[offset++] = y * 8 * 128;
                points[offset++] = (x + 1) * 128;
                points[offset++] = y * 8 * 128;
            }
        }
        // Vertical lines
        for (let x = 0; x < 9; x++) {
            for (let y = 0; y < 64; y++) {
                if (x !== 0 && x !== 8 && !chunkGrid) {
                    continue;
                }
                points[offset++] = x * 8 * 128;
                points[offset++] = y * 128;
                points[offset++] = x * 8 * 128;
                points[offset++] = (y + 1) * 128;
            }
        }

        return points;
    }

    initGrid(): void {
        const points = this.createGridPoints(false);

        this.gridVertexBuffer = this.app.createVertexBuffer(PicoGL.UNSIGNED_SHORT, 2, points);
        this.gridVertexArray = this.app
            .createVertexArray()
            .vertexAttributeBuffer(0, this.gridVertexBuffer);

        this.gridDrawCall = this.app
            .createDrawCall(this.gridProgram!, this.gridVertexArray)
            .uniformBlock("SceneUniforms", this.sceneUniformBuffer!)
            .primitive(PicoGL.LINES);

        const chunkPoints = this.createGridPoints(true);
        this.chunkGridVertexBuffer = this.app.createVertexBuffer(
            PicoGL.UNSIGNED_SHORT,
            2,
            chunkPoints,
        );
        this.chunkGridVertexArray = this.app
            .createVertexArray()
            .vertexAttributeBuffer(0, this.chunkGridVertexBuffer);

        this.chunkGridDrawCall = this.app
            .createDrawCall(this.gridProgram!, this.chunkGridVertexArray)
            .uniformBlock("SceneUniforms", this.sceneUniformBuffer!)
            .primitive(PicoGL.LINES);
    }

    initFramebuffers(): void {
        this.pickFramebuffer?.delete();
        this.pickColorTarget?.delete();
        this.pickDepthTarget?.delete();

        let samples = 0;

        this.pickColorTarget = this.app.createRenderbuffer(
            this.app.width,
            this.app.height,
            PicoGL.RGBA8,
            samples,
        );
        this.pickDepthTarget = this.app.createRenderbuffer(
            this.app.width,
            this.app.height,
            PicoGL.DEPTH_COMPONENT24,
            samples,
        );
        this.pickFramebuffer = this.app
            .createFramebuffer()
            .colorTarget(0, this.pickColorTarget)
            .depthTarget(this.pickDepthTarget);
    }

    initTextures(): void {
        const textureLoader = this.mapEditor.textureLoader;

        const allTextureIds = textureLoader.getTextureIds();

        this.textureIds = allTextureIds
            .filter((id) => textureLoader.isSd(id))
            .slice(0, MAX_TEXTURES - 1);

        this.initTextureArray();
        this.initMaterialsTexture();

        console.log("init textures", this.textureIds, allTextureIds.length);
    }

    initTextureArray() {
        if (this.textureArray) {
            this.textureArray.delete();
            this.textureArray = undefined;
        }
        this.loadedTextureIds.clear();

        console.time("load textures");

        const pixelCount = TEXTURE_SIZE * TEXTURE_SIZE;

        const textureCount = this.textureIds.length;
        const pixels = new Int32Array((textureCount + 1) * pixelCount);

        // White texture
        pixels.fill(0xffffffff, 0, pixelCount);

        const cacheInfo = this.mapEditor.loadedCache.info;

        let maxPreloadTextures = textureCount;
        // we should check if the texture loader is procedural instead
        if (cacheInfo.game === "runescape" && cacheInfo.revision >= 508) {
            maxPreloadTextures = 64;
        }

        for (let i = 0; i < Math.min(textureCount, maxPreloadTextures); i++) {
            const textureId = this.textureIds[i];
            try {
                const texturePixels = this.mapEditor.textureLoader.getPixelsArgb(
                    textureId,
                    TEXTURE_SIZE,
                    true,
                    1.0,
                );
                pixels.set(texturePixels, (i + 1) * pixelCount);
            } catch (e) {
                console.error("Failed loading texture", textureId, e);
            }
            this.loadedTextureIds.add(textureId);
        }

        this.textureArray = createTextureArray(
            this.app,
            new Uint8Array(pixels.buffer),
            TEXTURE_SIZE,
            TEXTURE_SIZE,
            textureCount + 1,
            {
                // wrapS: PicoGL.CLAMP_TO_EDGE,
                maxAnisotropy: PicoGL.WEBGL_INFO.MAX_TEXTURE_ANISOTROPY,
            },
        );

        console.timeEnd("load textures");
    }

    initMaterialsTexture(): void {
        if (this.textureMaterials) {
            this.textureMaterials.delete();
            this.textureMaterials = undefined;
        }

        const textureCount = this.textureIds.length + 1;

        const data = new Int8Array(textureCount * 4);
        for (let i = 0; i < this.textureIds.length; i++) {
            const id = this.textureIds[i];
            try {
                const material = this.mapEditor.textureLoader.getMaterial(id);

                const index = (i + 1) * 4;
                data[index] = material.animU;
                data[index + 1] = material.animV;
                data[index + 2] = material.alphaCutOff * 255;
            } catch (e) {
                console.error("Failed loading texture", id, e);
            }
        }

        this.textureMaterials = this.app.createTexture2D(data, textureCount, 1, {
            minFilter: PicoGL.NEAREST,
            magFilter: PicoGL.NEAREST,
            internalFormat: PicoGL.RGBA8I,
        });
    }

    override async queueLoadMap(mapX: number, mapY: number): Promise<void> {
        const mapData = await this.mapEditor.workerPool.queueLoadEditorMapData(mapX, mapY);
        if (
            !mapData ||
            !this.sceneUniformBuffer ||
            !this.textureArray ||
            !this.textureMaterials ||
            !this.terrainProgram
        ) {
            return;
        }

        this.mapManager.addMap(
            mapX,
            mapY,
            EditorMapSquare.create(
                this.app,
                mapData,
                this.sceneUniformBuffer,
                this.textureArray,
                this.textureMaterials,
                this.terrainProgram,
            ),
        );
    }

    async queueLoadTerrain(map: EditorMapSquare): Promise<void> {
        const mapData = await this.mapEditor.workerPool.queueLoadEditorMapTerrainData(
            map.mapX,
            map.mapY,
            map.heightMapTextureData,
        );
        if (!mapData) {
            return;
        }
        map.terrainVertexBuffer.data(mapData.terrainVertices);
    }

    override handleMouseInput(): void {
        super.handleMouseInput();

        const inputManager = this.mapEditor.inputManager;

        if (inputManager.scrollY !== 0) {
            const newBrushSize = this.brushSize - Math.sign(inputManager.scrollY);
            this.brushSize = clamp(newBrushSize, 0, 16);
        }
    }

    override onResize(width: number, height: number): void {
        this.app.resize(width, height);
        this.pickFramebuffer?.resize(width, height);
    }

    render(time: number, deltaTime: number, resized: boolean): void {
        const frameCount = this.stats.frameCount;

        if (!this.sceneUniformBuffer) {
            return;
        }

        const inputManager = this.mapEditor.inputManager;
        const camera = this.mapEditor.camera;

        this.handleInput(deltaTime);

        camera.update(this.canvas.width, this.canvas.height);

        const renderDistance = this.mapEditor.renderDistance;

        this.mapManager.update(camera, frameCount, renderDistance, this.mapEditor.unloadDistance);

        this.cameraPosUni[0] = camera.getPosX();
        this.cameraPosUni[1] = camera.getPosZ();

        this.sceneUniformBuffer
            .set(0, camera.viewProjMatrix as Float32Array)
            .set(1, camera.viewMatrix as Float32Array)
            .set(2, camera.projectionMatrix as Float32Array)
            .update();

        this.app.defaultDrawFramebuffer();
        this.app.defaultReadFramebuffer();

        this.app.clearColor(0.0, 0.0, 0.0, 1.0);
        this.app.clear();

        this.renderTerrain();

        this.renderTilePicking();

        this.handleTileManipulation(time);

        if (time - this.lastTimeTerrainUpdated > 100 && this.updatedTerrainMapIds.size > 0) {
            for (const mapId of this.updatedTerrainMapIds) {
                const map = this.mapManager.getMapById(mapId);
                if (!map) {
                    continue;
                }
                this.queueLoadTerrain(map);
            }

            this.updatedTerrainMapIds.clear();
            this.lastTimeTerrainUpdated = time;
        }
    }

    renderTerrain(): void {
        this.app.enable(PicoGL.DEPTH_TEST);
        this.app.enable(PicoGL.BLEND);

        for (let i = 0; i < this.mapManager.visibleMapCount; i++) {
            const map = this.mapManager.visibleMaps[i];

            map.terrainDrawCall.drawRanges(map.terrainDrawRanges[0]);
            map.terrainDrawCall.draw();
        }

        // this.app.disable(PicoGL.DEPTH_TEST);

        if (this.drawGrid || this.drawChunkGrid) {
            for (let i = 0; i < this.mapManager.visibleMapCount; i++) {
                const map = this.mapManager.visibleMaps[i];

                if (this.drawChunkGrid) {
                    this.chunkGridDrawCall.uniform("u_mapX", map.mapX);
                    this.chunkGridDrawCall.uniform("u_mapY", map.mapY);
                    this.chunkGridDrawCall.uniform("u_color", this.mapChunkGridColor);
                    this.chunkGridDrawCall.texture("u_heightMap", map.heightMapTexture);

                    this.chunkGridDrawCall.draw();
                }

                if (this.drawGrid) {
                    this.gridDrawCall.uniform("u_mapX", map.mapX);
                    this.gridDrawCall.uniform("u_mapY", map.mapY);
                    this.gridDrawCall.uniform("u_color", this.mapSquareGridColor);
                    this.gridDrawCall.texture("u_heightMap", map.heightMapTexture);

                    this.gridDrawCall.draw();
                }
            }
        }

        if (this.hoverWorldX !== -1 && this.hoverWorldY !== -1) {
            this.app.disable(PicoGL.DEPTH_TEST);
            const hoveredTilesMap = new Map<number, number[]>();
            for (let x = -this.brushSize; x <= this.brushSize; x++) {
                for (let y = -this.brushSize; y <= this.brushSize; y++) {
                    const worldX = this.hoverWorldX + x;
                    const worldY = this.hoverWorldY + y;
                    const mapX = Math.floor(worldX / 64);
                    const mapY = Math.floor(worldY / 64);
                    const tileX = worldX % 64;
                    const tileY = worldY % 64;
                    const tileId = (tileX << 8) | tileY;

                    const mapId = getMapSquareId(mapX, mapY);
                    const hoveredTiles = hoveredTilesMap.get(mapId);
                    if (hoveredTiles) {
                        hoveredTiles.push(tileId);
                    } else {
                        hoveredTilesMap.set(mapId, [tileId]);
                    }
                }
            }

            for (let i = 0; i < this.mapManager.visibleMapCount; i++) {
                const map = this.mapManager.visibleMaps[i];
                const mapId = getMapSquareId(map.mapX, map.mapY);
                const hoveredTiles = hoveredTilesMap.get(mapId);
                if (!hoveredTiles) {
                    continue;
                }
                this.highlightTileDrawCall.uniform("u_mapX", map.mapX);
                this.highlightTileDrawCall.uniform("u_mapY", map.mapY);
                this.highlightTileDrawCall.texture("u_heightMap", map.heightMapTexture);
                for (const tileId of hoveredTiles) {
                    const tileX = tileId >> 8;
                    const tileY = tileId & 0xff;
                    this.highlightTileDrawCall.uniform("u_tileX", tileX);
                    this.highlightTileDrawCall.uniform("u_tileY", tileY);
                    this.highlightTileDrawCall.draw();
                }
            }
        }
    }

    renderTilePicking(): void {
        if (!this.pickFramebuffer) {
            return;
        }
        this.app.enable(PicoGL.DEPTH_TEST);

        this.app.drawFramebuffer(this.pickFramebuffer);
        this.app.readFramebuffer(this.pickFramebuffer);

        this.app.clearMask(PicoGL.COLOR_BUFFER_BIT | PicoGL.DEPTH_BUFFER_BIT);
        this.app.clearColor(1.0, 0.0, 0.0, 1.0);
        // this.gl.clearBufferfv(PicoGL.COLOR, 0, [1.0, 0.0, 0.0, 1.0]);
        this.app.clear();

        // this.app.disable(PicoGL.CULL_FACE);
        this.app.disable(PicoGL.BLEND);

        for (let i = 0; i < this.mapManager.visibleMapCount; i++) {
            const map = this.mapManager.visibleMaps[i];

            this.tilePickingDrawCall.uniform("u_mapX", map.mapX);
            this.tilePickingDrawCall.uniform("u_mapY", map.mapY);
            this.tilePickingDrawCall.texture("u_heightMap", map.heightMapTexture);
            this.tilePickingDrawCall.draw();
        }

        const inputManager = this.mapEditor.inputManager;
        if (inputManager.mouseX !== -1 && inputManager.mouseY !== -1) {
            this.gl.readPixels(
                inputManager.mouseX,
                this.app.height - inputManager.mouseY,
                1,
                1,
                PicoGL.RGBA,
                PicoGL.UNSIGNED_BYTE,
                this.tilePickingBuffer,
            );

            const tileX = this.tilePickingBuffer[0];
            const tileY = this.tilePickingBuffer[1];

            const mapX = this.tilePickingBuffer[2];
            const mapY = this.tilePickingBuffer[3];

            const worldX = mapX * 64 + tileX;
            const worldY = mapY * 64 + tileY;

            const isValid = tileX !== 0xff;

            if (isValid) {
                this.hoverWorldX = worldX;
                this.hoverWorldY = worldY;

                this.mapEditor.debugText = `Map: ${mapX}, ${mapY} Tile: ${tileX}, ${tileY} World: ${worldX}, ${worldY}`;
            } else {
                this.hoverWorldX = -1;
                this.hoverWorldY = -1;
                this.mapEditor.debugText = "No tile selected";
            }
        }
    }

    handleTileManipulation(time: number): void {
        const inputManager = this.mapEditor.inputManager;

        if (this.hoverWorldX === -1 || this.hoverWorldY === -1 || !inputManager.isHolding()) {
            return;
        }

        const smoothing = inputManager.isControlDown();
        const decrement = inputManager.isAltDown();

        const borderSize = 6;

        const hoveredTilesMap = new Map<number, Set<number>>();

        const addTile = (mapId: number, tileId: number) => {
            const hoveredTiles = hoveredTilesMap.get(mapId);
            if (hoveredTiles) {
                hoveredTiles.add(tileId);
            } else {
                hoveredTilesMap.set(mapId, new Set([tileId]));
            }
        };

        const getHeightWorld = (worldX: number, worldY: number, tilePlane: number = 0): number => {
            const mapX = Math.floor(worldX / 64);
            const mapY = Math.floor(worldY / 64);
            const tileX = (worldX % 64) + borderSize;
            const tileY = (worldY % 64) + borderSize;
            const map = this.mapManager.getMap(mapX, mapY);
            if (!map) {
                return 0;
            }
            return map.getHeightMapHeight(tileX, tileY);
        };

        for (let x = -this.brushSize; x <= this.brushSize; x++) {
            for (let y = -this.brushSize; y <= this.brushSize; y++) {
                const worldX = this.hoverWorldX + x;
                const worldY = this.hoverWorldY + y;
                const mapX = Math.floor(worldX / 64);
                const mapY = Math.floor(worldY / 64);
                const tileX = (worldX % 64) + borderSize;
                const tileY = (worldY % 64) + borderSize;
                const tileId = (tileX << 8) | tileY;

                const mapId = getMapSquareId(mapX, mapY);
                addTile(mapId, tileId);

                const updateWest = tileX - borderSize <= borderSize;
                if (updateWest) {
                    const mapId = getMapSquareId(mapX - 1, mapY);
                    const westTileX = tileX + 64;
                    const westTileY = tileY;
                    const westTileId = (westTileX << 8) | westTileY;
                    addTile(mapId, westTileId);
                }
                const updateSouth = tileY - borderSize <= borderSize;
                if (updateSouth) {
                    const mapId = getMapSquareId(mapX, mapY - 1);
                    const southTileX = tileX;
                    const southTileY = tileY + 64;
                    const southTileId = (southTileX << 8) | southTileY;
                    addTile(mapId, southTileId);
                }
                const updateEast = tileX >= 64;
                if (updateEast) {
                    const mapId = getMapSquareId(mapX + 1, mapY);
                    const eastTileX = tileX - 64;
                    const eastTileY = tileY;
                    const eastTileId = (eastTileX << 8) | eastTileY;
                    addTile(mapId, eastTileId);
                }
                const updateNorth = tileY >= 64;
                if (updateNorth) {
                    const mapId = getMapSquareId(mapX, mapY + 1);
                    const northTileX = tileX;
                    const northTileY = tileY - 64;
                    const northTileId = (northTileX << 8) | northTileY;
                    addTile(mapId, northTileId);
                }
                if (updateSouth && updateWest) {
                    const mapId = getMapSquareId(mapX - 1, mapY - 1);
                    const southWestTileX = tileX + 64;
                    const southWestTileY = tileY + 64;
                    const southWestTileId = (southWestTileX << 8) | southWestTileY;
                    addTile(mapId, southWestTileId);
                }
                if (updateNorth && updateEast) {
                    const mapId = getMapSquareId(mapX + 1, mapY + 1);
                    const northEastTileX = tileX - 64;
                    const northEastTileY = tileY - 64;
                    const northEastTileId = (northEastTileX << 8) | northEastTileY;
                    addTile(mapId, northEastTileId);
                }
                if (updateSouth && updateEast) {
                    const mapId = getMapSquareId(mapX + 1, mapY - 1);
                    const southEastTileX = tileX - 64;
                    const southEastTileY = tileY + 64;
                    const southEastTileId = (southEastTileX << 8) | southEastTileY;
                    addTile(mapId, southEastTileId);
                }
                if (updateNorth && updateWest) {
                    const mapId = getMapSquareId(mapX - 1, mapY + 1);
                    const northWestTileX = tileX + 64;
                    const northWestTileY = tileY - 64;
                    const northWestTileId = (northWestTileX << 8) | northWestTileY;
                    addTile(mapId, northWestTileId);
                }
            }
        }

        if (smoothing) {
            const worldTileAverageHeightMap = new Map<number, number>();
            for (const [mapId, tileIds] of hoveredTilesMap) {
                const map = this.mapManager.getMapById(mapId);
                if (!map) {
                    continue;
                }
                for (const tileId of tileIds) {
                    const tileX = tileId >> 8;
                    const tileY = tileId & 0xff;
                    const worldX = map.mapX * 64 + tileX - borderSize;
                    const worldY = map.mapY * 64 + tileY - borderSize;
                    const worldTileId = (worldX << 16) | worldY;
                    if (worldTileAverageHeightMap.has(worldTileId)) {
                        continue;
                    }
                    let heightSum = 0;
                    for (let x = worldX - 1; x <= worldX + 1; x++) {
                        for (let y = worldY - 1; y <= worldY + 1; y++) {
                            heightSum += getHeightWorld(x, y);
                        }
                    }

                    const avg = Math.floor(heightSum / 9);

                    worldTileAverageHeightMap.set(worldTileId, avg);
                }
            }
            for (const [mapId, tileIds] of hoveredTilesMap) {
                const map = this.mapManager.getMapById(mapId);
                if (!map) {
                    continue;
                }

                for (const tileId of tileIds) {
                    const tileX = tileId >> 8;
                    const tileY = tileId & 0xff;
                    const worldX = map.mapX * 64 + tileX - borderSize;
                    const worldY = map.mapY * 64 + tileY - borderSize;
                    const worldTileId = (worldX << 16) | worldY;

                    const height = worldTileAverageHeightMap.get(worldTileId);
                    if (height) {
                        map.setHeightMapHeight(tileX, tileY, Math.max(height, 0));
                    }
                }
                map.updateHeightMapTexture(this.app);
                this.updatedTerrainMapIds.add(mapId);
            }
        } else {
            for (const [mapId, tileIds] of hoveredTilesMap) {
                const map = this.mapManager.getMapById(mapId);
                if (!map) {
                    continue;
                }

                for (const tileId of tileIds) {
                    const tileX = tileId >> 8;
                    const tileY = tileId & 0xff;

                    const height = map.getHeightMapHeight(tileX, tileY);

                    //todo make all above planes above incremented by the same amount
                    const adjustment = decrement ? -1 : 1;
                    map.setHeightMapHeight(tileX, tileY, Math.max(height + adjustment, 0));
                }
                map.updateHeightMapTexture(this.app);
                this.updatedTerrainMapIds.add(mapId);
            }
        }
    }

    clearMaps(): void {
        this.mapManager.cleanUp();
        // this.mapsToLoad.clear();
    }

    override async cleanUp(): Promise<void> {
        super.cleanUp();

        // Uniforms
        this.sceneUniformBuffer?.delete();
        this.sceneUniformBuffer = undefined;

        // Framebuffers
        this.pickFramebuffer?.delete();
        this.pickFramebuffer = undefined;
        this.pickColorTarget?.delete();
        this.pickColorTarget = undefined;
        this.pickDepthTarget?.delete();
        this.pickDepthTarget = undefined;

        // Textures
        this.textureArray?.delete();
        this.textureArray = undefined;
        this.textureMaterials?.delete();
        this.textureMaterials = undefined;

        this.clearMaps();

        if (this.shadersPromise) {
            for (const shader of await this.shadersPromise) {
                shader.delete();
            }
            this.shadersPromise = undefined;
        }
    }
}
