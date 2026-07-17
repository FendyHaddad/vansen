import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-privacy-page',
  templateUrl: './privacy-page.html',
  styleUrls: ['./legal-shared.css', './privacy-page.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
})
export class PrivacyPage {}
