/**
 * Draws an ECS renderer inside a Canvas, in hierarchy order with the sprites
 * (added automatically under a Canvas). Its own script: Cocos allows one
 * Component class per script.
 */
import { _decorator, Material, renderer, UIMeshRenderer } from 'cc';
import { JSB } from 'cc/env';
import { BatchedRenderer } from './batch';

const { ccclass, executeInEditMode, menu } = _decorator;

@ccclass('EcsUIRenderer')
@executeInEditMode
@menu('ECS/EcsUIRenderer')
export class EcsUIRenderer extends UIMeshRenderer {
    private list: { model: renderer.scene.Model; material: Material }[] = [];

    public _render(render: any): boolean {
        let comp = this.modelComponent as unknown as BatchedRenderer | null;
        if (!comp || typeof (comp as any)._uiBatches !== 'function') {
            comp = this.getComponent(BatchedRenderer as any) as any;
            if (comp) (this as any)._modelComponent = comp;
        }
        if (!comp || typeof (comp as any)._uiBatches !== 'function') return super._render(render);
        comp._detachFromScene();
        for (const b of comp._uiBatches(this.list)) render.commitModel(this, b.model, b.material);
        return true;
    }

    public update(): void {
        if (JSB) this.markForUpdateRenderData();
    }
}
