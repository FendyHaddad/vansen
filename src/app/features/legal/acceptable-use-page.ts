import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-acceptable-use-page',
  templateUrl: './acceptable-use-page.html',
  styleUrls: ['./legal-shared.css', './acceptable-use-page.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
})
export class AcceptableUsePage {}
