/**
 * ============================================================
 * © 2025 Diploy — a brand of Bisht Technologies Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Distributed under the Envato / CodeCanyon License Agreement.
 * Licensed to the purchaser for use as defined by the
 * Envato Market (CodeCanyon) Regular or Extended License.
 *
 * You are NOT permitted to redistribute, resell, sublicense,
 * or share this source code, in whole or in part.
 * Respect the author's rights and Envato licensing terms.
 * ============================================================
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { TFunction } from "i18next";
import type { UseMutationResult } from "@tanstack/react-query";
import type { Dispatch, SetStateAction } from "react";

export interface KnowledgeUploadDialogProps {
  knowledgeUploadOpen: boolean;
  setKnowledgeUploadOpen: Dispatch<SetStateAction<boolean>>;
  t: TFunction<"translation", undefined>;
  knowledgeData: { title: string; type: string; content: string; };
  setKnowledgeData: Dispatch<SetStateAction<{ title: string; type: string; content: string; }>>;
  uploadKnowledgeMutation: UseMutationResult<any, any, void, unknown>;
}

export function KnowledgeUploadDialog({ knowledgeUploadOpen, setKnowledgeUploadOpen, t, knowledgeData, setKnowledgeData, uploadKnowledgeMutation }: KnowledgeUploadDialogProps) {
  return (
    <Dialog open={knowledgeUploadOpen} onOpenChange={setKnowledgeUploadOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('agents.knowledge.uploadTitle')}</DialogTitle>
                <DialogDescription>
                  {t('agents.knowledge.uploadDescription')}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="knowledge-title">{t('agents.knowledge.titleLabel')} *</Label>
                  <Input
                    id="knowledge-title"
                    placeholder={t('agents.knowledge.titlePlaceholder')}
                    value={knowledgeData.title}
                    onChange={(e) => setKnowledgeData({ ...knowledgeData, title: e.target.value })}
                    data-testid="input-knowledge-title"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="knowledge-content">{t('agents.knowledge.contentLabel')} *</Label>
                  <Textarea
                    id="knowledge-content"
                    placeholder={t('agents.knowledge.contentPlaceholder')}
                    rows={10}
                    value={knowledgeData.content}
                    onChange={(e) => setKnowledgeData({ ...knowledgeData, content: e.target.value })}
                    data-testid="input-knowledge-content"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setKnowledgeUploadOpen(false)}>
                  {t('common.cancel')}
                </Button>
                <Button
                  onClick={() => uploadKnowledgeMutation.mutate()}
                  disabled={!knowledgeData.title || !knowledgeData.content || uploadKnowledgeMutation.isPending}
                  data-testid="button-upload-knowledge-submit"
                >
                  {uploadKnowledgeMutation.isPending ? t('agents.knowledge.uploading') : t('agents.knowledge.uploadButton')}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
  );
}
